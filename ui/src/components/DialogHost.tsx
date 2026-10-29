import { lazy, Suspense, type ComponentType } from 'react';
import { closeDialog, useDialogs, type DialogKind, type DialogPropsMap } from '../store/dialogs';
import { ConfirmDialog, InputDialog } from './dialogs/SmallDialogs';

type Props<K extends DialogKind> = { props: DialogPropsMap[K]; close: () => void };
type Registry = { [K in DialogKind]: ComponentType<Props<K>> };

const small = () => import('./dialogs/SmallDialogs');
const sync = () => import('./dialogs/SyncDialogs');
const tools = () => import('./dialogs/ToolDialogs');

const registry: Registry = {
  confirm: ConfirmDialog,
  input: InputDialog,
  copy: lazy(() => import('./dialogs/CopyDialog')),
  properties: lazy(() => import('./dialogs/PropertiesDialog')),
  siteManager: lazy(() => import('./dialogs/SiteManager')),
  preferences: lazy(() => import('./dialogs/PreferencesDialog')),
  sync: lazy(() => sync().then((m) => ({ default: m.SyncDialog }))),
  syncChecklist: lazy(() => sync().then((m) => ({ default: m.SyncChecklistDialog }))),
  keepUpToDate: lazy(() => sync().then((m) => ({ default: m.KeepUpToDateDialog }))),
  find: lazy(() => tools().then((m) => ({ default: m.FindDialog }))),
  tunnels: lazy(() => tools().then((m) => ({ default: m.TunnelsDialog }))),
  commands: lazy(() => tools().then((m) => ({ default: m.CommandsDialog }))),
  share: lazy(() => tools().then((m) => ({ default: m.ShareDialog }))),
  commandOutput: lazy(() => small().then((m) => ({ default: m.CommandOutputDialog }))),
  vault: lazy(() => small().then((m) => ({ default: m.VaultDialog }))),
  about: lazy(() => small().then((m) => ({ default: m.AboutDialog }))),
  connectPeer: lazy(() => small().then((m) => ({ default: m.ConnectPeerDialog }))),
  addPeer: lazy(() => small().then((m) => ({ default: m.AddPeerDialog }))),
  selectMask: lazy(() => small().then((m) => ({ default: m.SelectMaskDialog }))),
  checksum: lazy(() => small().then((m) => ({ default: m.ChecksumDialog }))),
  createArchive: lazy(() => small().then((m) => ({ default: m.CreateArchiveDialog }))),
  symlink: lazy(() => small().then((m) => ({ default: m.SymlinkDialog }))),
  sessionInfo: lazy(() => small().then((m) => ({ default: m.SessionInfoDialog }))),
  shortcuts: lazy(() => small().then((m) => ({ default: m.ShortcutsDialog }))),
};

export function DialogHost() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((d) => {
        const C = registry[d.kind] as ComponentType<Props<DialogKind>>;
        return (
          <Suspense key={d.id} fallback={<div className="dlg-backdrop dlg-loading" />}>
            <C props={d.props} close={() => closeDialog(d.id)} />
          </Suspense>
        );
      })}
    </>
  );
}
