import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SidebarRootInjected } from './contract/slots.ts';
/** Full props of the shell.leading occupant. */
export type HeaderLeadingControlsProps = PropsRuntime<'shell.leading'> & InjectFace<SidebarRootInjected> & PropsLocale<'sidebar'>;
/**
 * Sidebar-open and New Session controls in the frame's window-chrome seat.
 * The frame mounts this seat for hidden sidebars and owns its placement.
 * Web shows only the sidebar opener; Desktop also retains New Session.
 * @param props - Injected sidebar actions, the global access Hook, and the sidebar locale seat.
 * @returns the sidebar toggle, plus New Session on Desktop while access allows `session/create`.
 */
export declare function HeaderLeadingControls({ toggleSidebar, startSession, trackEntryClick, useRemoteAccess, useShortcuts, t, }: HeaderLeadingControlsProps): import("react").JSX.Element;
//# sourceMappingURL=HeaderLeadingControls.d.ts.map