/** 本机定制包的只读预检；未知上游覆盖不能视为完成升级。 */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
const FAMILY = 'dsh-jethub-preserved-customizations-v1';
function readContract(root) {
    const value = JSON.parse(readFileSync(resolve(root, 'customization-contract.json'), 'utf8'));
    if (value.format !== 1 || value.family !== FAMILY || !Array.isArray(value.requiredProviders))
        throw Error('JetHub 定制保留契约缺失或格式未知；保留当前程序');
    return value;
}
function checkFiles(root, files) {
    const base = realpathSync(root);
    for (const [name, expected] of Object.entries(files)) {
        const file = resolve(base, name);
        if (!file.startsWith(base + sep) || !existsSync(file))
            throw Error(`JetHub 定制文件缺失：${name}；保留当前程序`);
        const physical = realpathSync(file);
        if (!physical.startsWith(base + sep))
            throw Error(`JetHub 定制文件越出源码目录：${name}`);
        const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
        if (actual !== expected)
            throw Error(`JetHub 定制文件未经复核：${name}；保留当前程序`);
    }
    return Object.keys(files).length;
}
export function validateCustomizationSource(sourceDir, options = {}) {
    const contract = readContract(sourceDir);
    const pkg = JSON.parse(readFileSync(resolve(sourceDir, 'package.json'), 'utf8'));
    if (pkg.name !== 'dsh-providers-hub' || pkg.dshLocalIntegration?.upstreamCommit !== contract.upstreamCommit)
        throw Error('JetHub 包身份或上游来源与定制契约不一致');
    let checkedFiles = checkFiles(sourceDir, contract.runtimeFingerprints);
    if (options.verifySources === true)
        checkedFiles += checkFiles(sourceDir, contract.sourceFingerprints);
    if (contract.requiredProviders.length < 22)
        throw Error('JetHub 定制契约遗漏原有渠道');
    return { ok: true, family: contract.family, upstreamCommit: contract.upstreamCommit, requiredProviders: contract.requiredProviders, checkedFiles };
}
export function inheritCustomizationContract(installedDir, candidateDir) {
    const old = readContract(installedDir);
    const next = readContract(candidateDir);
    for (const provider of old.requiredProviders)
        if (!next.requiredProviders.includes(provider))
            throw Error(`JetHub 升级将丢失渠道 ${provider}；保留当前程序`);
    validateCustomizationSource(candidateDir);
    // 已批准定制的程序逐字保持才可自动继承；真正需要改这些文件时由维护流程复核。
    checkFiles(candidateDir, old.runtimeFingerprints);
    return { ok: true, family: next.family, requiredProviders: next.requiredProviders };
}
//# sourceMappingURL=customization-guard.js.map