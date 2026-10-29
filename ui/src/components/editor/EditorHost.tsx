import { lazy, Suspense } from 'react';
import { useEditors } from '../../store/editors';
import { Spinner } from '../ui';

const EditorWindow = lazy(() => import('./EditorWindow'));

export function EditorHost() {
  const visible = useEditors((s) => s.visible && s.tabs.length > 0);
  if (!visible) return null;
  return (
    <Suspense
      fallback={
        <div className="editor-overlay">
          <div className="center-fill">
            <Spinner />
          </div>
        </div>
      }
    >
      <EditorWindow />
    </Suspense>
  );
}
