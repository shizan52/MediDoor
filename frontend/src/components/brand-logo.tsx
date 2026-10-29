import Image from "next/image";

/**
 * MediDoor wordmark + icon. Loaded at full intrinsic size so it stays sharp
 * even when the parent sets a larger height (e.g. h-16 on the login screen).
 */
export function BrandLogo({
  className = "h-14 w-auto",
  priority = true,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <div className={className}>
      <Image
        src="/brand/logo-inside.png"
        alt="MediDoor"
        width={640}
        height={160}
        priority={priority}
        sizes="(max-width: 768px) 220px, 320px"
        className="h-full w-auto object-contain dark:brightness-0 dark:invert"
      />
    </div>
  );
}
