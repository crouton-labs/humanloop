import { useEffect, useId, useState } from 'react';
import { Maximize2, X } from 'lucide-react';

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
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    setSvg(null);
    void import('mermaid').then(async ({ default: mermaid }) => {
      configureMermaid(mermaid);
      const { svg: rendered } = await mermaid.render(`humanloop-mermaid-${id}`, source);
      if (active) setSvg(rendered);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Unable to render Mermaid diagram.');
    });
    return () => {
      active = false;
    };
  }, [id, source]);

  // Escape closes the full-screen view; captured so it never leaks to the
  // review keymap underneath.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);

  if (error !== null) {
    return (
      <pre className="mermaid-error" title={error}>
        <code className="language-mermaid">{source}</code>
      </pre>
    );
  }

  return (
    <div className="mermaid-diagram">
      {svg !== null && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mermaid-expand-btn"
          aria-label="Expand diagram to full screen"
          title="Expand diagram"
        >
          <Maximize2 className="size-4" />
        </button>
      )}
      <div
        className="mermaid-diagram-svg"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={svg !== null ? { __html: svg } : undefined}
      />
      {expanded && svg !== null && (
        <div className="mermaid-fullscreen" onClick={() => setExpanded(false)}>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mermaid-fullscreen-close"
            aria-label="Close full-screen diagram"
            title="Close (Esc)"
          >
            <X className="size-5" />
          </button>
          <div
            className="mermaid-fullscreen-svg"
            onClick={(event) => event.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  );
}
