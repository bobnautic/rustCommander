import {
  Archive, ClipboardCopy, Copy, Download, Edit3, ExternalLink, Eye, FilePlus, FolderInput, FolderOpen, FolderPlus, Hash, Info,
  Link2, ListChecks, MoveRight, PackageOpen, Pencil, RefreshCw, SquareTerminal, Trash2, Upload, Command, Settings2, Globe,
} from 'lucide-react';
import type { FileEntry } from '../../api/types';
import { tr } from '../../i18n';
import { isArchive, isDirLike } from '../../lib/fileTypes';
import { sessionById, useApp } from '../../store/app';
import { openDialog } from '../../store/dialogs';
import { getPanel, PARENT, refresh, selectAll, targets, type Side } from '../../store/panels';
import * as ops from '../../actions/fileOps';
import type { MenuItem } from '../Menu';

export function commandsSubmenu(side: Side): MenuItem[] {
  const cmds = useApp.getState().commands;
  return [
    ...cmds.map((c) => ({ label: c.name, icon: Command, onClick: () => void ops.runCustomCommand(side, c) })),
    ...(cmds.length ? [{ separator: true }] : []),
    { label: tr('commands.manage'), icon: Settings2, onClick: () => openDialog('commands', { side }) },
  ];
}

/** Items for the file context menu. `entry` null = background of the panel. */
export function buildPanelMenu(side: Side, entry: FileEntry | null): MenuItem[] {
  const p = getPanel(side);
  const s = sessionById(p.session);
  const caps = s?.capabilities;
  const info = useApp.getState().info;
  const web = info?.mode === 'web';
  const desktop = info?.mode === 'desktop';
  const isLocal = p.session === 'local';
  const sel = targets(side);
  const multi = sel.length > 1;
  const isParent = entry?.name === PARENT;

  if (!entry || isParent) {
    return [
      { label: tr('ops.newFolder'), icon: FolderPlus, shortcut: 'F7', onClick: () => void ops.makeDir(side) },
      { label: tr('ops.newFile'), icon: FilePlus, shortcut: 'Shift+F4', onClick: () => void ops.newFile(side) },
      { label: tr('ops.createLink'), icon: Link2, hidden: !caps?.symlinks, onClick: () => ops.createSymlink(side) },
      { separator: true },
      { label: tr('web.upload'), icon: Upload, hidden: !web, onClick: () => void ops.uploadFromComputer(side) },
      { label: tr('web.uploadFolder'), icon: FolderInput, hidden: !web, onClick: () => void ops.uploadFromComputer(side, true) },
      { separator: true },
      { label: tr('common.refresh'), icon: RefreshCw, shortcut: 'Ctrl+R', onClick: () => void refresh(side) },
      { label: tr('panel.selectAll'), icon: ListChecks, shortcut: 'Ctrl+A', onClick: () => selectAll(side) },
      { label: tr('ops.copyPath'), icon: ClipboardCopy, onClick: () => void ops.copyText(p.path) },
      { label: tr('ops.openTerminalHere'), icon: SquareTerminal, hidden: !info?.features.terminal, onClick: () => ops.openTerminalHere(side) },
      { label: tr('ops.openInFileManager'), icon: FolderOpen, hidden: !(desktop && isLocal && info?.features.openLocal), onClick: () => ops.openWithSystem(side) },
      { label: tr('commands.title'), icon: Command, submenu: commandsSubmenu(side) },
      { separator: true },
      { label: tr('ops.properties'), icon: Info, shortcut: 'Alt+Enter', onClick: () => void ops.showProperties(side) },
    ];
  }

  const dir = isDirLike(entry);
  const file = !dir;
  return [
    { label: tr('ops.open'), icon: FolderOpen, shortcut: 'Enter', hidden: multi, onClick: () => ops.openEntry(side, entry) },
    { label: tr('ops.edit'), icon: Edit3, shortcut: 'F4', hidden: !file || multi, onClick: () => ops.editFocused(side) },
    { label: tr('ops.view'), icon: Eye, shortcut: 'F3', hidden: !file || multi, onClick: () => ops.viewFocused(side) },
    { label: tr('ops.openWithSystem'), icon: ExternalLink, hidden: !(desktop && isLocal && info?.features.openLocal) || multi, onClick: () => ops.openWithSystem(side) },
    { label: tr('ops.editExternal'), icon: ExternalLink, hidden: !(desktop && !isLocal && info?.features.externalEdit) || !file || multi, onClick: () => void ops.externalEdit(side, entry) },
    { label: tr('web.openInBrowser'), icon: Globe, hidden: !web || !file || multi, onClick: () => void ops.openInBrowser(side) },
    { separator: true },
    { label: tr('ops.copy'), icon: Copy, shortcut: 'F5', onClick: () => ops.copySelection(side, false) },
    { label: tr('ops.move'), icon: MoveRight, shortcut: 'F6', onClick: () => ops.copySelection(side, true) },
    { label: tr('web.download'), icon: Download, hidden: !web, onClick: () => void ops.downloadToComputer(side) },
    { separator: true },
    { label: tr('ops.rename'), icon: Pencil, shortcut: 'F2', hidden: multi, onClick: () => ops.renameFocused(side) },
    { label: tr('common.delete'), icon: Trash2, shortcut: 'F8', danger: true, onClick: () => void ops.deleteSelection(side) },
    { separator: true },
    { label: tr('ops.newFolder'), icon: FolderPlus, shortcut: 'F7', onClick: () => void ops.makeDir(side) },
    { label: tr('ops.newFile'), icon: FilePlus, shortcut: 'Shift+F4', onClick: () => void ops.newFile(side) },
    { label: tr('ops.createLink'), icon: Link2, hidden: !caps?.symlinks, onClick: () => ops.createSymlink(side) },
    { separator: true },
    { label: multi ? tr('ops.copyPaths') : tr('ops.copyPath'), icon: ClipboardCopy, onClick: () => ops.copyPaths(side) },
    { label: tr('ops.copyUrl'), icon: Link2, hidden: multi, onClick: () => void ops.copyUrl(side) },
    { label: tr('ops.checksum'), icon: Hash, hidden: !file || multi, onClick: () => ops.showChecksum(side) },
    { label: tr('ops.openTerminalHere'), icon: SquareTerminal, hidden: !info?.features.terminal, onClick: () => ops.openTerminalHere(side) },
    { label: tr('commands.title'), icon: Command, submenu: commandsSubmenu(side) },
    {
      label: tr('archive.title'),
      icon: Archive,
      hidden: !isLocal,
      submenu: [
        { label: tr('archive.extractHere'), icon: PackageOpen, disabled: !(file && isArchive(entry.name)) || multi, onClick: () => void ops.extractArchive(side) },
        { label: tr('archive.create'), icon: Archive, onClick: () => ops.createArchive(side) },
      ],
    },
    { separator: true },
    { label: tr('ops.properties'), icon: Info, shortcut: 'Alt+Enter', onClick: () => void ops.showProperties(side) },
  ];
}
