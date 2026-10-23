import { useState } from 'react';

/** Render one title logo, retaining readable text until the artwork loads. */
export default function DetailTitleLogo({ title, sources }: { title: string; sources: string[] }) {
  return <TitleArtwork key={JSON.stringify(sources)} title={title} sources={sources} />;
}

function TitleArtwork({ title, sources }: { title: string; sources: string[] }) {
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const source = sources[index];
  return <h1 className="relative text-4xl font-semibold text-white">
    <span className={loaded ? 'sr-only' : undefined}>{title}</span>
    {source ? <img src={source} alt="" aria-hidden="true" referrerPolicy="no-referrer"
      className={loaded ? 'block max-h-24 w-auto max-w-full object-contain object-left sm:max-w-[360px]' : 'absolute h-px w-px opacity-0'}
      onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setIndex(value => value + 1); }} /> : null}
  </h1>;
}
