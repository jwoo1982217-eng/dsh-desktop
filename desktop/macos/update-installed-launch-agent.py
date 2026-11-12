"""Point the existing DSH login job at its installed macOS application."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile


def update(plist_path, app_path, expected_sha256, backup_path, apply=False):
    plist_path, app_path, backup_path = map(Path, (plist_path, app_path, backup_path))
    raw = plist_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected_sha256:
        raise ValueError('LaunchAgent changed; keep the current configuration')
    old = plistlib.loads(raw)
    if old.get('Label') != 'ai.deepseek.dsh' or not old.get('RunAtLoad'):
        raise ValueError('Expected the existing DSH login service')
    if app_path != Path('/Applications/DSH.app') or app_path.is_symlink():
        raise ValueError('Use the reviewed installed application')
    info = plistlib.loads((app_path/'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != 'com.dsh.desktop':
        raise ValueError('Unexpected application identity')
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app_path)], check=True)
    env = old.get('EnvironmentVariables', {})
    if set(env) != {'DSH_HOME', 'PATH'} or any(not isinstance(v, str) for v in env.values()):
        raise ValueError('Review nonstandard launch environment before migration')
    working = Path(old.get('WorkingDirectory', ''))
    if not working.is_absolute() or not working.is_dir() or not Path(env['DSH_HOME']).is_dir():
        raise ValueError('Existing DSH home must remain present')
    new = dict(old)
    resources = app_path/'Contents/Resources'
    daemon = resources/'bin/desktop-host/daemon.mjs'
    node = resources/'bin/node'
    if not daemon.is_file() or not node.is_file():
        raise ValueError('Installed backend entry points are missing')
    # The signed app executable supplies the same macOS permission identity.
    # Electron runs only this Node host; the GUI remains a separate borrower.
    args = [str(app_path/'Contents/MacOS/DSH'), str(daemon), '--home', env['DSH_HOME'],
            '--runtime', str(resources/'runtime'), '--node', str(node), '--port', '3080']
    new['ProgramArguments'] = args
    new['EnvironmentVariables'] = {**env, 'ELECTRON_RUN_AS_NODE': '1'}
    # Backend owns an eight-second graceful/forced child shutdown window.
    # launchd must allow the host to finish it before terminating the host.
    new['ExitTimeOut'] = max(15, old.get('ExitTimeOut', 0))
    after = plistlib.dumps(new, fmt=plistlib.FMT_XML, sort_keys=False)
    result = {'label': old['Label'], 'application': str(app_path), 'appVersion': info['CFBundleShortVersionString'],
              'beforeSha256': digest, 'afterSha256': hashlib.sha256(after).hexdigest(),
              'changedKeys': [k for k in new if new[k] != old.get(k)], 'otherKeysPreserved': True,
              'originalEnvironmentPreserved': all(new['EnvironmentVariables'].get(k) == v for k, v in env.items()),
              'originalWorkingDirectoryPreserved': new.get('WorkingDirectory') == old.get('WorkingDirectory'),
              'hostMode': 'signed-app-node-daemon',
              'runAtLoad': new['RunAtLoad'], 'keepAlive': new.get('KeepAlive'), 'applied': False}
    if not apply:
        return result
    backup_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if backup_path.exists():
        if backup_path.is_symlink() or backup_path.read_bytes() != raw:
            raise ValueError('Preserve the existing backup')
    else:
        with backup_path.open('xb') as handle:
            os.chmod(backup_path, 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
    fd, name = tempfile.mkstemp(prefix='.dsh-login-', dir=plist_path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            os.fchmod(handle.fileno(), plist_path.stat().st_mode & 0o777)
            handle.write(after)
            handle.flush()
            os.fsync(handle.fileno())
        subprocess.run(['/usr/bin/plutil', '-lint', name], check=True, stdout=subprocess.DEVNULL)
        if plist_path.read_bytes() != raw:
            raise ValueError('Concurrent LaunchAgent update; preserve it')
        os.replace(name, plist_path)
        if plistlib.loads(plist_path.read_bytes()) != new:
            raise ValueError('LaunchAgent readback mismatch; retain original backup')
    finally:
        Path(name).unlink(missing_ok=True)
    result['applied'] = True
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plist', required=True)
    parser.add_argument('--app', required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--backup', required=True)
    parser.add_argument('--apply', action='store_true')
    a = parser.parse_args()
    print(json.dumps(update(a.plist, a.app, a.expected_sha256, a.backup, a.apply)))
