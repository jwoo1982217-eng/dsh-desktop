/** Rows for the More menus of the left sidebar, Conversation View tabs, and right-sidebar guide. */
import type { Context } from '@deepseek-ai/cordis';
import { en } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** More menu rows: navigation actions, and Creator draft prompts. */
        entryCustomization: keyof typeof en;
    }
}
/** Services used by the menu rows' footer actions; the optional `pluginNavigation` shows the discovery row while present. */
export declare const inject: string[];
/**
 * Register the same menu rows into each region's More menu.
 * @param ctx - Browser context with slot, locale, and Workspace services, and the optional plugin navigation.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map