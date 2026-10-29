import { cn } from "../../lib/utils.js";

const REPO = "https://github.com/sriinnu/tokmeter";
const VERSION = __TOKMETER_VERSION__;

/**
 * Who made this and which build it is. Plain links only: nothing here is
 * fetched (no avatars, badges or API calls), so the page still makes no
 * off-origin request until the user clicks.
 */
export function AboutBlock({ className }: { className?: string }) {
  const link =
    "rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
  return (
    <p className={cn("grid gap-0.5 text-xs text-muted-foreground", className)}>
      <a
        href={`${REPO}/releases/tag/v${VERSION}`}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(link, "justify-self-start")}
      >
        Tokmeter{" "}
        <span className="num" data-version>
          v{VERSION}
        </span>
      </a>
      <span>Built by Srinivas Pendela</span>
      <a
        href={REPO}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(link, "justify-self-start")}
      >
        github.com/sriinnu/tokmeter
      </a>
    </p>
  );
}
