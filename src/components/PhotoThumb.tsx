import { useEffect, useState } from 'react';
import { photoUrl } from '../lib/photos';

export function PhotoThumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    void photoUrl(id).then((u) => {
      if (!alive) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      created = u;
      setUrl(u);
    });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [id]);
  if (!url) return <span className="muted">图片加载中…</span>;
  return <img src={url} alt="报修照片" />;
}
