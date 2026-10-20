#!/usr/bin/env python3
"""Stage a program-only flattened runtime with verified Windows native packages."""
import argparse, hashlib, json, os, shutil, struct, subprocess, tarfile, urllib.request, zipfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent

def safe_name(value):
    p = PurePosixPath(value)
    if p.is_absolute() or '..' in p.parts or '\\' in value:
        raise ValueError('Archive path escapes destination: ' + value)
    return p

def download(item, cache):
    name = item['url'].rsplit('/', 1)[-1]
    file = cache / name
    if not file.exists():
        temporary = file.with_suffix(file.suffix + '.partial')
        with urllib.request.urlopen(item['url'], timeout=180) as response, temporary.open('wb') as out:
            shutil.copyfileobj(response, out)
        temporary.replace(file)
    if hashlib.sha256(file.read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Archive checksum mismatch: ' + name)
    return file

def unzip(file, target):
    with zipfile.ZipFile(file) as archive:
        for entry in archive.infolist():
            safe_name(entry.filename)
            if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unexpected zip symlink')
        archive.extractall(target)

def stage_vcrt(archive, target, sevenzip, temporary):
    # Pinned Microsoft Burn installer: its attached CAB contains the x64 CRT CAB.
    data = archive.read_bytes()
    offset = 0
    containers = []
    temporary.mkdir(parents=True, exist_ok=True)
    while True:
        offset = data.find(b'MSCF', offset)
        if offset < 0:
            break
        size = struct.unpack_from('<I', data, offset + 8)[0]
        if data[offset+4:offset+8] == bytes(4) and 36 <= size <= len(data) - offset:
            file = temporary / f'container-{len(containers)}.cab'
            file.write_bytes(data[offset:offset+size])
            containers.append(file)
        offset += 4
    if len(containers) != 2:
        raise ValueError('Unexpected Microsoft redistributable container layout')
    packages = temporary / 'packages'
    subprocess.run([str(sevenzip), 'x', '-y', '-o' + str(packages), str(containers[1])], check=True, stdout=subprocess.DEVNULL)
    crt = temporary / 'crt'
    subprocess.run([str(sevenzip), 'x', '-y', '-o' + str(crt), str(packages / 'a4')], check=True, stdout=subprocess.DEVNULL)
    files = sorted(crt.glob('*.dll_amd64'))
    if len(files) != 12 or not (crt / 'vcruntime140.dll_amd64').is_file():
        raise ValueError('Unexpected x64 CRT payload')
    for file in files:
        shutil.copy2(file, target / file.name.removesuffix('_amd64'))
    shutil.copy2(HERE / 'VCRT-LICENSE.html', target / 'VCRT-LICENSE.html')
    shutil.rmtree(temporary)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--sevenzip', required=True, type=Path)
    args = parser.parse_args()
    source = args.runtime.resolve()
    stage = args.out.resolve()
    if source == stage or source in stage.parents or stage in source.parents:
        raise ValueError('Source and staging directories must be separate')
    version = json.loads((HERE / '../macos/app/package.json').read_text())['version']
    if json.loads((source / 'bundle.json').read_text())['version'] != version:
        raise ValueError('Runtime and app versions differ')
    lock = json.loads((HERE / 'runtime-lock.json').read_text())
    args.cache.mkdir(parents=True, exist_ok=True)
    archives = [(item, download(item, args.cache)) for item in lock['archives']]
    # Reject external links before copytree dereferences any source link.
    for directory, dirs, files in os.walk(source):
        for name in dirs + files:
            p = Path(directory) / name
            if p.is_symlink() and not p.resolve(strict=True).is_relative_to(source):
                raise ValueError('External runtime link: ' + str(p.relative_to(source)))
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    electron = next(file for item, file in archives if '/electron/' in item['url'])
    unzip(electron, stage)
    (stage / 'electron.exe').rename(stage / 'DSH.exe')
    default = stage / 'resources/default_app.asar'
    default.unlink(missing_ok=True)
    runtime = stage / 'resources/runtime'
    shutil.copytree(source, runtime, symlinks=False, ignore=shutil.ignore_patterns('.DS_Store', '.cache'))
    modules = runtime / 'node_modules'
    for name in ['.modules.yaml', '.pnpm-workspace-state-v1.json']:
        (modules / name).unlink(missing_ok=True)
    removed = []
    for parent in [modules] + [p for p in modules.iterdir() if p.name.startswith('@') and p.is_dir()]:
        for package in list(parent.iterdir()):
            if not package.is_dir() or not (package / 'package.json').is_file():
                continue
            meta = json.loads((package / 'package.json').read_text())
            systems, cpus = meta.get('os', []), meta.get('cpu', [])
            if (systems and 'win32' not in systems) or (cpus and 'x64' not in cpus):
                removed.append(str(package.relative_to(modules)))
                shutil.rmtree(package)
    for item, file in archives:
        if 'name' not in item:
            continue
        destination = modules / item['name']
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        with tarfile.open(file) as archive:
            for member in archive:
                p = safe_name(member.name)
                if not p.parts or p.parts[0] != 'package' or member.issym() or member.islnk():
                    raise ValueError('Unexpected npm archive member: ' + member.name)
                target = destination.joinpath(*p.parts[1:])
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as src, target.open('wb') as out:
                        shutil.copyfileobj(src, out)
                else:
                    raise ValueError('Unsupported archive member')
        actual = json.loads((destination / 'package.json').read_text())
        if actual['name'] != item['name'] or actual['version'] != item['version']:
            raise ValueError('Native package identity mismatch')
    # node-pty ships several platforms in one package. Keep only Windows x64.
    prebuilds = modules / 'node-pty/prebuilds'
    for p in prebuilds.iterdir():
        if p.name != 'win32-x64':
            shutil.rmtree(p)
    arm_conpty = modules / 'node-pty/third_party/conpty'
    for p in arm_conpty.glob('*/win10-arm64'):
        shutil.rmtree(p)
    unpacked = stage.parent / 'node-unpacked'
    if unpacked.exists():
        shutil.rmtree(unpacked)
    unpacked.mkdir()
    node_zip = next(file for item, file in archives if 'nodejs.org' in item['url'])
    unzip(node_zip, unpacked)
    node_root = next(unpacked.iterdir())
    bin_dir = stage / 'resources/bin'
    shutil.copytree(node_root, bin_dir)
    shutil.rmtree(unpacked)
    shutil.copy2(HERE / 'backend-runner.mjs', bin_dir / 'backend-runner.mjs')
    vcrt = next(file for item, file in archives if item.get('kind') == 'vc-redist')
    stage_vcrt(vcrt, bin_dir, args.sevenzip.resolve(), stage.parent / 'vcrt-unpacked')
    shutil.copy2(modules / 'opencode-windows-x64-baseline/bin/opencode.exe', bin_dir / 'opencode.exe')
    # One copy suffices; the launcher supplies the exact bundled executable.
    shutil.rmtree(modules / 'opencode-windows-x64-baseline')
    shutil.copy2(HERE / 'OPENCODE-NOTICES.txt', bin_dir / 'OPENCODE-NOTICES.txt')
    (runtime / 'THIRD-PARTY-NOTICES.txt').write_text(
        f'DSH desktop Windows x64 {version}\nDSH core 0.2.1-alpha.4; Electron 44.7.2; Node.js 24.14.0.\n'
        'Node.js license: ../bin/LICENSE; Electron/Chromium licenses: ../../LICENSE*\n'
        'Dependency license files remain alongside the packages. Program files only; no user profile included.\n', encoding='utf-8')
    # Detect case collisions and names Windows cannot represent before making an installer.
    seen = set()
    for p in stage.rglob('*'):
        relative = p.relative_to(stage)
        key = str(relative).casefold()
        if key in seen or any(c in p.name for c in '<>:"|?*') or p.name.endswith((' ', '.')):
            raise ValueError('Windows-incompatible path: ' + str(relative))
        seen.add(key)
        if p.is_symlink():
            raise ValueError('Staging contains a symlink: ' + str(relative))
    receipt = {'platform': 'win32-x64', 'removedForeignPackages': removed, 'archives': lock['archives'], 'files': sum(p.is_file() for p in stage.rglob('*'))}
    (stage.parent / 'stage-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Staged', receipt['files'], 'program files')

if __name__ == '__main__':
    main()
