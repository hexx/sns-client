import type { RichSegment } from '../../../shared/types';

/** 統一インラインリッチテキスト（ADR-0005）を描画する */
export function RichText({ segments }: { segments: RichSegment[] }) {
  return (
    <p className="text">
      {segments.map((s, i) => {
        switch (s.type) {
          case 'text':
            return <span key={i}>{s.text}</span>;
          case 'link':
            return (
              <a key={i} className="rt-link" href={s.url} target="_blank" rel="noopener noreferrer">
                {s.text ?? s.url}
              </a>
            );
          case 'mention':
            return (
              <span key={i} className="rt-mention">
                @{s.handle}
              </span>
            );
          case 'hashtag':
            return (
              <span key={i} className="rt-hashtag">
                #{s.tag}
              </span>
            );
          case 'emoji':
            return s.url ? (
              <img key={i} className="rt-emoji" src={s.url} alt={`:${s.name}:`} title={`:${s.name}:`} />
            ) : (
              <span key={i}>{s.char ?? s.name}</span>
            );
        }
      })}
    </p>
  );
}
