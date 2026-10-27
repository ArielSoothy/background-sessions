#!/usr/bin/env python3
"""Display local background session metadata, grouped by working folder."""
import argparse
import datetime as dt
import fnmatch
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time
import unicodedata

MAX_BYTES = 1024 * 1024
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]+$')
STATUS = {
    'yours': ('yellow', '33', 'your turn'),
    'working': ('green', '32', 'working'),
    'error': ('red', '31', 'error/ctx≥80%'),
    'closed': ('blue', '2;34', 'closed'),
    'unknown': ('', '', 'unknown'),
}
STATE_TEXT = {'yours': '! YOU', 'working': '▶', 'error': '✗', 'closed': '✓', 'unknown': '?'}
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def clean(value):
    text = ANSI.sub('', value if isinstance(value, str) else '')
    return ''.join(' ' if unicodedata.category(c) in ('Cc', 'Cf', 'Cs') else c for c in text)


def number(value):
    try:
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None
    except OverflowError:
        return None


def millis(value):
    if number(value) is not None:
        return value
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.timestamp() * 1000 if parsed.tzinfo is not None else None
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def contained(path, anchor):
    try:
        Path(path).resolve().relative_to(Path(anchor).resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def open_directory(path):
    """Open a resolved trusted anchor; no-follow traversal starts below it."""
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def read_json(path, default=None, anchor=None):
    """Use directory descriptors, no-follow opens, regular-file checks and a byte cap."""
    if path is None:
        return default
    directory = None
    try:
        path = Path(path)
        if path.suffix != '.json':
            return default
        base = Path(anchor) if anchor is not None else path.parent
        relative = path.relative_to(base)
        if '..' in relative.parts:
            return default
        directory = open_directory(base)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        for part in relative.parts[:-1]:
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        before = os.stat(relative.name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
            return default
        fd = os.open(relative.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(fd, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_BYTES:
                return default
            raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                return default
            return json.loads(raw)
    except (OSError, ValueError, UnicodeError, RuntimeError, RecursionError):
        return default
    finally:
        if directory is not None:
            os.close(directory)


def row_status(state, tasks=None, percent=None, closed=False):
    """One status per row; hooks/board.ts rowStatus is the TypeScript twin.

    A background job writes state 'done' after EVERY reply (idle, your turn); only 'stopped'
    or an explicit done marker means the session is closed."""
    s = str(state or '').lower().replace('_', '-')
    if closed or s == 'stopped':
        return 'closed'
    if re.search(r'error|fail|crash', s) or (number(percent) is not None and percent >= 80):
        return 'error'
    if re.search(r'wait|input|permission|approval|blocked', s):
        return 'yours'
    if s in ('working', 'running', 'active') or (number(tasks) or 0) > 0:
        return 'working'
    if s in ('done', 'idle', 'completed', 'complete', 'finished'):
        return 'yours'
    return 'unknown'


def legend_line(color=True):
    parts = []
    for key in ('yours', 'working', 'error', 'closed'):
        name, code, label = STATUS[key]
        dot = f'\x1b[{code}m●\x1b[0m' if color else '●'
        parts.append(f'{dot} {name} {label}')
    return ' · '.join(parts)


def short_label(folder, limit=12):
    """Unknown folders keep whole words: break on - or _ boundaries, never mid-word."""
    pieces = re.split(r'(?=[-_])', folder)
    label = ''
    for piece in pieces:
        if len(label + piece) > limit:
            break
        label += piece
    return label or folder[:limit]


def expand_path(value, home):
    if not isinstance(value, str) or not value or '\0' in value:
        return None
    if value == '~' or value.startswith('~/'):
        if home is None:
            return None
        value = str(home) + value[1:]
    return os.path.normpath(value) if os.path.isabs(value) else None


def parse_catalog(data, home):
    records = data.get('projects', []) if isinstance(data, dict) else data
    if not isinstance(records, list):
        return []
    result = []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('id'), str):
            continue
        location = record.get('location')
        root = expand_path(location.get('local_path') if isinstance(location, dict) else location, home)
        if not root:
            continue
        title = record.get('display_title')
        name = title.split(' — ')[0].strip() if isinstance(title, str) else record['id']
        result.append({'projectId': record['id'], 'projectName': name, 'roots': [root]})
    return result


def discover_projects(home, config):
    values = config.get('roots')
    roots = []
    if isinstance(values, list):
        roots = [p for p in (expand_path(v, home) for v in values) if p]
    elif home is not None:
        for folder in ('Projects', 'code', 'src', 'dev', 'repos'):
            try:
                roots.extend(str(p) for p in sorted((home / folder).iterdir()) if p.is_dir() and not p.name.startswith('.'))
            except OSError:
                pass
    return [{'projectId': Path(p).name or p, 'projectName': Path(p).name or p, 'roots': [p]} for p in roots]


def configure_projects(projects, config):
    settings = config.get('projects') if isinstance(config.get('projects'), dict) else {}
    merges = config.get('merge') if isinstance(config.get('merge'), dict) else {}
    def target(pid):
        seen = set()
        current = pid
        while current not in seen:
            seen.add(current)
            dest = merges.get(current)
            if dest is None:
                dest = next((v for k, v in merges.items() if '*' in k and fnmatch.fnmatchcase(current, k)), None)
            if not isinstance(dest, str) or not dest or dest == current:
                return current
            current = dest
        return pid
    by_id = {p['projectId']: p for p in projects}
    grouped = {}
    for project in projects:
        pid = clean(target(project['projectId'])).strip() or 'other'
        group = grouped.setdefault(pid, {'projectId': pid, 'projectName': by_id.get(pid, {}).get('projectName', pid), 'roots': []})
        group['roots'].extend(project['roots'])
    for pid, project in grouped.items():
        value = settings.get(pid)
        value = value if isinstance(value, dict) else {}
        title, short = value.get('title'), value.get('short')
        if isinstance(title, str) and title.strip():
            project['projectName'] = title
        project['projectName'] = clean(project['projectName'])
        project['projectShort'] = clean(short) if isinstance(short, str) and short.strip() else short_label(project['projectName'])
    return list(grouped.values())


def project_for_cwd(cwd, projects, home):
    cwd = expand_path(cwd, home)
    if not cwd:
        return {'projectId': 'other', 'projectName': 'Other', 'projectShort': 'Other', 'projectSource': 'Other'}
    canonical = os.path.realpath(cwd)
    matches = [(len(os.path.realpath(root)), project) for project in projects for root in project['roots']
               if canonical == os.path.realpath(root) or canonical.startswith(os.path.realpath(root).rstrip('/') + '/')]
    if matches:
        project = max(matches, key=lambda item: item[0])[1]
        return {k: v for k, v in dict(project, projectSource='cwd').items() if k != 'roots'}
    path = Path(cwd)
    boundary = Path(os.path.realpath(home)) if home else None
    for parent in (path, *path.parents):
        resolved = Path(os.path.realpath(parent))
        if boundary is None or (resolved != boundary and boundary not in resolved.parents):
            break
        try:
            (parent / '.git').lstat()
            path = parent
            break
        except OSError:
            pass
    pid = path.name or cwd
    fallback = configure_projects([{'projectId': pid, 'projectName': pid, 'roots': [str(path)]}], {})[0]
    return {k: v for k, v in dict(fallback, projectSource='cwd').items() if k != 'roots'}


def group_rows(rows):
    latest = {}
    for row in rows:
        latest[row['projectId']] = max(latest.get(row['projectId'], 0), row['lastWorkedAt'] or 0)
    return sorted(rows, key=lambda r: (-latest[r['projectId']], r['projectId'], -(r['lastWorkedAt'] or 0), r['id']))


def write_record(root, kind, sid, text):
    """Atomic, plugin-only writes; no followed directory links or opened destination files."""
    if os.getenv('BACKGROUND_SESSIONS_READ_ONLY') == '1':
        return False
    if kind not in ('usage', 'done') or not SAFE_ID.fullmatch(sid) or len(text) > MAX_BYTES:
        return False
    try:
        value = json.loads(text)
    except (ValueError, RecursionError):
        return False
    if not isinstance(value, dict) or number(value.get('at')) is None:
        return False
    if kind == 'usage':
        if value.get('sessionId') != sid or not isinstance(value.get('model'), str):
            return False
        value = dict(sessionId=sid, model=clean(value['model']), at=number(value['at']),
                     **{k: number(value.get(k)) for k in ('contextUsed', 'window', 'percent')})
    elif value.get('cleared') is True:
        value = {'cleared': True, 'at': number(value['at'])}
    elif value.get('reason') in ('done-command', 'session-end'):
        value = {'reason': value['reason'], 'at': number(value['at']),
                 **({'suffixName': clean(value['suffixName'])} if isinstance(value.get('suffixName'), str) else {})}
    else:
        return False
    clearing = kind == 'done' and value.get('cleared') is True
    directory, temporary = None, None
    try:
        # The trusted config root must exist. Create only our own descendants.
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory = open_directory(Path(os.path.realpath(root)))
        data = Path(os.path.realpath(Path(root) / 'background-sessions'))
        try:
            child = open_directory(data)
        except FileNotFoundError:
            if clearing:
                return True
            os.mkdir('background-sessions', 0o700, dir_fd=directory)
            child = open_directory(data)
        os.close(directory)
        directory = child
        for part in (kind,):
            try:
                child = os.open(part, flags, dir_fd=directory)
            except FileNotFoundError:
                if clearing:
                    return True
                os.mkdir(part, 0o700, dir_fd=directory)
                child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        name = sid + '.json'
        try:
            if not stat.S_ISREG(os.stat(name, dir_fd=directory, follow_symlinks=False).st_mode):
                return False
        except FileNotFoundError:
            if clearing:
                return True
        temporary = '.' + secrets.token_hex(12) + '.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, 'wb') as stream:
            stream.write((json.dumps(value, ensure_ascii=False) + '\n').encode('utf-8'))
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
        return True
    except (OSError, ValueError, UnicodeError):
        return clearing and not Path(root).exists()
    finally:
        if temporary is not None and directory is not None:
            try:
                os.unlink(temporary, dir_fd=directory)
            except OSError:
                pass
        if directory is not None:
            os.close(directory)


def prune_files(data_dir, live, jobs):
    """Only unlink regular plugin files through verified, non-followed directory handles."""
    if data_dir.is_symlink() or contained(data_dir, jobs):
        return
    root_fd = None
    try:
        root_fd = open_directory(data_dir)
        for kind in (None, 'usage', 'done'):
            directory = None
            try:
                directory = os.dup(root_fd) if kind is None else os.open(kind, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
                for name in os.listdir(directory):
                    if not (name.endswith('.tmp') or (kind is not None and name.endswith('.json') and name[:-5] not in live)):
                        continue
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode):
                        os.unlink(name, dir_fd=directory)
            except OSError:
                pass
            finally:
                if directory is not None:
                    os.close(directory)
    except OSError:
        pass
    finally:
        if root_fd is not None:
            os.close(root_fd)


def collect(jobs, catalog_path, data_dir, writable=False, home=None, own_session=None):
    now = int(time.time() * 1000)
    jobs, data_dir = Path(os.path.realpath(jobs)), Path(os.path.realpath(data_dir))
    home = Path(home) if home else Path(os.getenv('HOME')) if os.getenv('HOME') else None
    config = read_json(data_dir / 'projects.json', {}, data_dir)
    config = config if isinstance(config, dict) else {}
    catalog_path = catalog_path or expand_path(config.get('catalog'), home)
    projects = parse_catalog(read_json(catalog_path), home) if catalog_path else []
    known = {root for p in projects for root in p['roots']}
    projects.extend(p for p in discover_projects(home, config) if p['roots'][0] not in known)
    projects = configure_projects(projects, config)
    rows, live, errors = [], {own_session} if own_session and SAFE_ID.fullmatch(own_session) else set(), []
    inventory_complete = True
    jobs_fd = None
    try:
        jobs_fd = open_directory(jobs)
        names = sorted(os.listdir(jobs_fd))
        names = [name for name in names if stat.S_ISDIR(os.stat(name, dir_fd=jobs_fd, follow_symlinks=False).st_mode)]
        states = [jobs / name / 'state.json' for name in names]
        live.update(names)
    except FileNotFoundError:
        states = []
    except OSError:
        states = []
        errors.append('Jobs directory unreadable.')
        inventory_complete = False
    finally:
        if jobs_fd is not None:
            os.close(jobs_fd)
    for path in states:
        state = read_json(path, anchor=jobs)
        if not isinstance(state, dict):
            inventory_complete = False
            continue
        # Drop unused fields immediately, including any prompt or status detail.
        state = {key: state[key] for key in ('sessionId', 'cwd', 'originCwd', 'state', 'name', 'color', 'createdAt', 'updatedAt', 'lastTerminalAt', 'inFlight') if key in state}
        flight = state.get('inFlight')
        state['inFlight'] = {'tasks': flight.get('tasks')} if isinstance(flight, dict) else None
        del flight
        sid = state.get('sessionId', path.parent.name)
        if not isinstance(sid, str) or not SAFE_ID.fullmatch(sid):
            inventory_complete = False
            continue
        live.add(sid)
        report = read_json(data_dir / 'usage' / (sid + '.json'), {}, data_dir)
        report = report if isinstance(report, dict) and report.get('sessionId') == sid else {}
        marker = read_json(data_dir / 'done' / (sid + '.json'), {}, data_dir)
        closed = state.get('state') == 'stopped' or (isinstance(marker, dict) and bool(marker) and not marker.get('cleared'))
        cwd = expand_path(state.get('cwd'), home) or expand_path(state.get('originCwd'), home)
        project = project_for_cwd(cwd, projects, home)
        # Apply title/merge settings to a folder discovered by the cheap fallback too.
        if project['projectSource'] == 'cwd' and not any(p['projectId'] == project['projectId'] for p in projects):
            project = dict(configure_projects([dict(project, roots=[])], config)[0], projectSource='cwd')
            project.pop('roots', None)
        worked = [millis(state.get(k)) for k in ('updatedAt', 'lastTerminalAt')]
        flight = state.get('inFlight')
        raw_name = state.get('name') if isinstance(state.get('name'), str) else None
        row = {'id': sid, 'job': path.parent.name, 'name': clean(raw_name or path.parent.name),
               'rawName': clean(raw_name) if raw_name is not None else None,
               'state': clean(state.get('state') or 'unknown'), 'jobColor': clean(state.get('color')),
               'tasks': number(flight.get('tasks')) if isinstance(flight, dict) else None, 'closed': bool(closed),
               'startedAt': millis(state.get('createdAt')), 'lastWorkedAt': max((v for v in worked if v is not None), default=None),
               'model': clean(report.get('model')), 'contextUsed': number(report.get('contextUsed')), 'window': number(report.get('window')),
               'percent': number(report.get('percent')), 'contextSource': 'reported' if report else 'unknown', **project}
        row['status'] = row_status(row['state'], row['tasks'], row['percent'], row['closed'])
        row['statusColor'] = STATUS[row['status']][0]
        rows.append(row)
    if writable and inventory_complete and os.getenv('BACKGROUND_SESSIONS_READ_ONLY') != '1':
        prune_files(data_dir, live, jobs)
    return {'at': now, 'rows': group_rows(rows), 'errors': errors, 'inventoryComplete': inventory_complete}


def format_age(ms):
    if ms is None:
        return '-'
    minutes = int(max(0, ms)//60000)
    return 'now' if minutes < 1 else f'{minutes}m' if minutes < 60 else f'{minutes//60}h' if minutes < 1440 else f'{minutes//1440}d'


def display_width(text):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1 for c in text)


def fit(text, width):
    result, used = '', 0
    for char in clean(text):
        size = display_width(char)
        if used + size > width:
            break
        result += char
        used += size
    return result + ' '*max(0, width-used)


def status_of(row):
    return row.get('status') or row_status(row.get('state'), row.get('tasks'), row.get('percent'), row.get('closed'))


def state_display(status):
    code = STATUS.get(status, STATUS['unknown'])[1]
    return STATE_TEXT.get(status, '?'), ('1;33' if status == 'yours' else code)


def context_display(row):
    # Plain text: colour is reserved for the session state (the dot and state cell).
    percent = row.get('percent')
    if percent is not None:
        return f'{math.floor(percent+0.5)}%'+(' new session?' if percent >= 80 else ''), ''
    used = row.get('contextUsed')
    return ('-' if used is None else f'{math.floor(used/1000+0.5)}k' if used >= 1000 else str(used)), '2'


def started_text(at, now):
    if at is None:
        return '-'
    try:
        date = dt.datetime.fromtimestamp(at/1000)
        today = dt.datetime.fromtimestamp(now/1000)
        return date.strftime('today %H:%M' if date.date() == today.date() else '%b %d %H:%M')
    except (ValueError, OverflowError, OSError):
        return '-'


def render_table(board, width, color=True):
    width = max(1, width)
    name_width = max((display_width(row['name']) for row in board['rows']), default=20)
    project_width = max((display_width(row.get('projectShort', row['projectName'])) for row in board['rows']), default=10)
    # Preserve the name and state; remove optional columns whole when space is tight.
    widths = [1, min(20, project_width), max(16, name_width), 5, 16, 14, 5, 6]
    def total():
        return sum(widths) + max(0, sum(size > 0 for size in widths) - 1)
    widths[2] = max(16, widths[2] - max(0, total() - width))
    for index in (5, 7, 6, 4, 1):
        if total() <= width:
            break
        widths[index] = 0
    widths[2] = max(0, widths[2] - max(0, total() - width))
    widths[2] += max(0, width - total())
    plain = legend_line(False)
    lines = [legend_line(color) if display_width(plain) <= width else fit(plain, width).rstrip()]
    def paint(text, code):
        return f'\x1b[{code}m{text}\x1b[0m' if color and text and code else text
    for row in board['rows']:
        status = status_of(row)
        state, state_code = state_display(status)
        context, context_code = context_display(row)
        model = re.search(r'opus|sonnet|fable|haiku', row['model'], re.I)
        closed = status == 'closed'
        dot_code = STATUS.get(status, STATUS['unknown'])[1]
        fields = [('●', dot_code), (row.get('projectShort', row['projectName']), ''), (row['name'], ''), (state, state_code), (context, context_code),
                  (started_text(row['startedAt'], board['at']), ''),
                  (format_age(None if row['lastWorkedAt'] is None else board['at']-row['lastWorkedAt']), ''),
                  (model.group().lower() if model else row['model'] or '-', '')]
        segments, room = [], width
        for i, ((text, code), size) in enumerate(zip(fields, widths)):
            if not size:
                continue
            if segments and room:
                segments.append(' '); room -= 1
            size = min(room, size)
            segments.append(paint(fit(text, size), '2;34' if closed else code)); room -= size
        lines.append(''.join(segments).rstrip())
    return '\n'.join(lines)


def terminal_width():
    """Read the terminal directly without consulting sizing environment variables."""
    try:
        width = os.get_terminal_size(sys.__stdout__.fileno()).columns
        return width if width > 0 else 160
    except (OSError, ValueError, AttributeError):
        return 160


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Emit pane data.')
    parser.add_argument('--own-session', help='Preserve records for the running foreground session.')
    parser.add_argument('--read-marker', metavar='SESSION_ID', help='Read an owned done marker.')
    parser.add_argument('--read-only', action='store_true', help='Disable all writes and pruning of plugin-owned files.')
    parser.add_argument('--width', type=int, default=None)
    parser.add_argument('--no-color', action='store_true')
    parser.add_argument('--write-record', nargs=3, metavar=('KIND', 'SESSION_ID', 'JSON'), help='Write an owned usage or done record.')
    args = parser.parse_args()
    home = os.getenv('HOME')
    valid_home = Path(home) if home and os.path.isabs(home) else None
    configured = os.getenv('CLAUDE_CONFIG_DIR') or (str(valid_home / '.claude') if valid_home else None)
    root = expand_path(configured, valid_home)
    root = os.path.realpath(root) if root else None
    if args.read_marker:
        data = Path(os.path.realpath(Path(root) / 'background-sessions')) if root else None
        marker = read_json(data / 'done' / (args.read_marker + '.json'), {}, data) if data and SAFE_ID.fullmatch(args.read_marker) else {}
        print(json.dumps(marker))
        return 0
    if args.write_record:
        allowed = root is not None and not args.read_only and os.getenv('BACKGROUND_SESSIONS_READ_ONLY') != '1'
        print(json.dumps({'written': bool(allowed and write_record(root, *args.write_record))}))
        return 0
    board = {'at': int(time.time() * 1000), 'rows': [], 'errors': []}
    if root:
        board = collect(Path(root) / 'jobs', None, Path(root) / 'background-sessions', not args.read_only, home=valid_home, own_session=args.own_session)
    if args.json:
        print(json.dumps(board, separators=(',', ':')))
    else:
        print(render_table(board, args.width if args.width is not None else terminal_width(),
                           not args.no_color and os.getenv('BACKGROUND_SESSIONS_NO_COLOR') != '1'))
        if not board['rows'] and not board['errors']:
            print('No background sessions.')
        for error in board['errors']:
            print('background-sessions: ' + error, file=sys.stderr)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0)
