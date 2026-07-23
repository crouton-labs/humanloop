import { useEffect, useId, useRef, useState } from 'react';

let configured = false;

function configureMermaid(mermaid: typeof import('mermaid').default): void {
  if (configured) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      fontFamily: 'inherit',
      primaryColor: '#e8eefc',
      primaryTextColor: '#1e293b',
      primaryBorderColor: '#6684d9',
      lineColor: '#64748b',
      secondaryColor: '#eef2f7',
      tertiaryColor: '#f8fafc',
    },
  });
  configured = true;
}

export function isMermaidClassName(className: string | undefined): boolean {
  return className?.split(/\s+/).includes('language-mermaid') ?? false;
}

export function MermaidDiagram({ source }: { source: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void import('mermaid').then(async ({ default: mermaid }) => {
      configureMermaid(mermaid);
      const { svg } = await mermaid.render(`humanloop-mermaid-${id}`, source);
      if (active && containerRef.current !== null) containerRef.current.innerHTML = svg;
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Unable to render Mermaid diagram.');
    });
    return () => {
      active = false;
    };
  }, [id, source]);

  if (error !== null) {
    return (
      <pre className="mermaid-error" title={error}>
        <code className="language-mermaid">{source}</code>
      </pre>
    );
  }

  return <div ref={containerRef} className="mermaid-diagram" aria-label="Mermaid diagram" />;
}
