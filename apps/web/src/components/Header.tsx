import Link from 'next/link';
import { CreditsButton } from './CreditsButton';
import { HeaderSearch } from './HeaderSearch';
import { BrandLogo } from './icons';
import { NavLinks } from './NavLinks';
import { ThemeToggle } from './ThemeToggle';
import { TokenPrice } from './TokenPrice';
import { WalletButton } from './WalletButton';

/** The sticky top bar from the prototype: brand, nav pills, search, token price, theme, credits, wallet. */
export function Header() {
  return (
    <header className="top">
      <div className="wrap top-in">
        <Link className="brand" href="/" aria-label="ApeCheck home">
          <BrandLogo />
          apecheck
        </Link>
        <NavLinks className="nav" id="nav" />
        <HeaderSearch />
        <div className="top-r">
          <TokenPrice />
          <ThemeToggle />
          <CreditsButton />
          <WalletButton />
        </div>
      </div>
      <NavLinks className="nav-m" id="navm" />
    </header>
  );
}
