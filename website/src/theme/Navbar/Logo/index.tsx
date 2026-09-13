import type { ReactNode } from "react";
import Logo from "@theme/Logo";

/** Keep Docusaurus' native logo/home link while giving narrow chrome a whole label. */
export default function NavbarLogo(): ReactNode {
  return (
    <Logo
      className="navbar__brand aa-node-navbar-brand"
      imageClassName="navbar__logo"
      titleClassName="navbar__title text--truncate aa-node-navbar-title"
      aria-label="@agent-assembly/sdk"
    />
  );
}
