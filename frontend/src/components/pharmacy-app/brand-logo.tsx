import Image from "next/image";

/**
 * 1:1 port of mobile-pharmacy/src/components/brand-logo.tsx so the
 * /pharmacy web section renders the exact same wordmark treatment as
 * the 3200 PWA (separate from the site-wide BrandLogo, which uses the
 * desktop logo-inside.png + dark invert).
 */
export function BrandLogo({
  className = "h-8 w-auto",
  priority = true,
  iconOnly = false,
}: {
  className?: string;
  priority?: boolean;
  iconOnly?: boolean;
}) {
  if (iconOnly) {
    return (
      <span className={`relative block aspect-square overflow-hidden rounded-full bg-white shadow-sm ring-1 ring-slate-200/70 dark:ring-white/10 ${className}`}>
        <Image
          src="/brand/logo-outside-bg.png"
          alt="medidoor"
          fill
          priority={priority}
          sizes="40px"
          className="object-cover"
        />
      </span>
    );
  }

  return (
    <div className={`inline-flex items-center ${className}`}>
      <Image
        src="/brand/logo-inside-mobile.png"
        alt="medidoor"
        width={729}
        height={150}
        priority={priority}
        sizes="150px"
        className="h-full w-auto object-contain dark:brightness-0 dark:invert"
        style={{ width: "auto", height: "100%" }}
      />
    </div>
  );
}
