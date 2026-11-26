import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card({ title, extra, children }: { title?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || extra) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {extra}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'danger' | 'ghost' };

export function Button({ tone = 'ghost', className, ...rest }: BtnProps) {
  return <button className={`btn btn-${tone} ${className ?? ''}`} {...rest} />;
}

export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

export function KeyVal({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {pairs.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
