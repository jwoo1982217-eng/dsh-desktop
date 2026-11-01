export declare function validateCustomizationSource(sourceDir: string, options?: {
    verifySources?: boolean;
}): {
    ok: boolean;
    family: string;
    upstreamCommit: string;
    requiredProviders: string[];
    checkedFiles: number;
};
export declare function inheritCustomizationContract(installedDir: string, candidateDir: string): {
    ok: boolean;
    family: string;
    requiredProviders: string[];
};
//# sourceMappingURL=customization-guard.d.ts.map