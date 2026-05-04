import { Reveal } from "./Reveal";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  lead?: string;
}

export function PageHeader({ eyebrow, title, lead }: PageHeaderProps) {
  return (
    <header className="border-b border-border bg-bg-card/40">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 md:py-20 text-center">
        <Reveal>
          <span className="font-catchy inline-block text-accent text-sm font-bold mb-3 tracking-wide">
            {eyebrow}
          </span>
          <h1 className="font-display font-black text-3xl md:text-5xl text-text-primary leading-tight tracking-tight">
            {title}
          </h1>
          {lead ? (
            <p className="text-text-secondary mt-5 text-base md:text-lg leading-relaxed max-w-2xl mx-auto">
              {lead}
            </p>
          ) : null}
        </Reveal>
      </div>
    </header>
  );
}
