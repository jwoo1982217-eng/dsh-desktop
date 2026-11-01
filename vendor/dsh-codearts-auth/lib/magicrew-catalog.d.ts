/**
 * 拉 `GET /api/v1/flows/models` 并归一成适配器要的形状。
 *
 * ⚠️ 该端点**不返回** ctx / 档位（实测 27 条全字段确认）⇒ 本模块只负责
 * id / 名称 / vision 三项，其余由静态表补。
 */
import type { MagicrewProduct } from './magicrew-product.js';
export interface MagicrewCatalogModel {
    readonly id: string;
    readonly name: string;
    readonly vision: boolean;
}
export declare function fetchMagicrewCatalogModels(params: {
    jwt: string;
    organizationCode: string;
    product?: MagicrewProduct;
    fetchImpl?: typeof fetch;
}): Promise<readonly MagicrewCatalogModel[]>;
//# sourceMappingURL=magicrew-catalog.d.ts.map