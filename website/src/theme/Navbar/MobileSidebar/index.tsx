import { useEffect, type ReactNode } from "react";
import OriginalMobileSidebar from "@theme-original/Navbar/MobileSidebar";

/** Keep the native reading menu; complete its missing Escape dismissal. */
export default function MobileSidebar(): ReactNode {
  useEffect(() => {
    let frame: number | undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !document.querySelector(".navbar-sidebar--show")) return;
      event.preventDefault();
      document.querySelector<HTMLButtonElement>(".navbar-sidebar__close")?.click();
    };
    const onClose = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".navbar-sidebar__close"))
        return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const sidebar = document.querySelector<HTMLElement>(".navbar-sidebar");
        if (sidebar) sidebar.scrollLeft = 0;
        if (!document.querySelector(".navbar-sidebar--show")) {
          document
            .querySelector<HTMLButtonElement>(".navbar__toggle")
            ?.focus({ preventScroll: true });
        }
      });
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClose, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClose, true);
    };
  }, []);
  return <OriginalMobileSidebar />;
}
