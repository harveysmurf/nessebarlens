import { containerClass } from "@/components/PageShell";
import type { Dictionary } from "@/components/i18n/dictionaries";

export function SiteFooter({ copy }: { copy: Dictionary["footer"] }) {
  return (
    <footer className="bg-gallery-50 border-t border-gallery-200/80 py-10 mt-auto">
      <div
        className={`${containerClass("7xl")} flex flex-col sm:flex-row justify-between items-center text-xs text-stone-500 gap-4`}
      >
        <p>{copy.copyright}</p>
        <p className="text-[10px] uppercase tracking-widest">
          {copy.fulfillment}
        </p>
      </div>
    </footer>
  );
}
