import { useState } from 'react';
import { Timeline } from './components/Timeline';
import { Compose } from './components/Compose';
import type { Post } from '../../shared/types';

type ComposeState = { open: boolean; replyTo?: Post; quote?: Post };

export default function App() {
  const [compose, setCompose] = useState<ComposeState>({ open: false });
  const [justPosted, setJustPosted] = useState<Post | null>(null);

  return (
    <>
      <Timeline
        justPosted={justPosted}
        onCompose={() => setCompose({ open: true })}
        onReply={(p) => setCompose({ open: true, replyTo: p })}
        onQuote={(p) => setCompose({ open: true, quote: p })}
      />
      {compose.open && (
        <Compose
          replyTo={compose.replyTo}
          quote={compose.quote}
          onClose={() => setCompose({ open: false })}
          onPosted={(post) => setJustPosted(post)}
        />
      )}
    </>
  );
}
