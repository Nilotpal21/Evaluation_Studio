export function Footer() {
  return (
    <footer className="pt-4 pb-2 text-[11px] text-foreground-subtle flex items-center justify-between border-t border-border-muted">
      <span>Netomi prototype · mock data</span>
      <span className="font-mono">v0.2.0 · {new Date().getFullYear()}</span>
    </footer>
  );
}
