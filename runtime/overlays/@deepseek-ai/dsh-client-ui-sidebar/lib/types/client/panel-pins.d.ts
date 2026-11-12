/** In-memory pin choices for the global panel launchers. */
import { type ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
/** Panel whose launcher always shows and never enters the customization list. */
export declare const FIXED_PANEL_ID = "plugins";
/** Unpinned panel ids and their only mutation. */
export interface PanelPins {
    /** Unpinned panel ids; ids of panels that are not registered stay listed. */
    readonly unpinned: ObservableSnapshot<readonly string[]>;
    /**
     * Pin or unpin one panel launcher; the fixed panel is ignored.
     * @param id - Panel id.
     * @param pinned - Whether the launcher is manually pinned.
     */
    readonly setPinned: (id: string, pinned: boolean) => void;
}
/**
 * Create the in-memory panel pin list; the snapshot keeps its reference until the list changes.
 * @returns Unpinned panel ids and the pin mutation.
 */
export declare function createPanelPins(): PanelPins;
//# sourceMappingURL=panel-pins.d.ts.map