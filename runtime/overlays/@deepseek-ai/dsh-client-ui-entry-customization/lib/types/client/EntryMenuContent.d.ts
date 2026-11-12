import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Navigation region whose More menu hosts one registration. */
export type EntryRegion = 'sidebar' | 'conversation' | 'rightbar';
/** Region identity and footer actions injected into each registration. */
export interface EntryMenuInjected {
    /** Region of this registration; selects analytics attributes and the Creator prompt. */
    readonly region: EntryRegion;
    readonly hooks: {
        /** Whether the Plugins page navigation service is present; the discovery row shows only while it is. */
        readonly pluginNavigation: HostObservable<boolean>;
    };
    /** Open the Plugins main list. */
    readonly browsePlugins: () => void;
    /** Start a Creator draft with this region's prompt without sending it. */
    readonly createPlugin: () => void;
}
type EntryMenuContentProps = PropsRuntime<'sidebar.panellist.actions'> & PropsLocale<'entryCustomization'> & InjectFace<EntryMenuInjected>;
/**
 * Render folded Conversation Views followed by discovery and Creator actions, without pin controls.
 * @param props - Owner dismissal callback, injected actions, and localized copy.
 * @returns Menu rows for the region's More menu.
 */
export declare function EntryMenuContent({ entries, onOpen, region, onDismiss, usePluginNavigation, browsePlugins, createPlugin, t, }: EntryMenuContentProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=EntryMenuContent.d.ts.map