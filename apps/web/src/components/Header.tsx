import Link from 'next/link';
import { TELEGRAM_URL, X_URL } from '@/lib/env';
import { CreditsButton } from './CreditsButton';
import { HeaderSearch } from './HeaderSearch';
import { BrandLogo, TelegramIcon, XLogoIcon } from './icons';
import { NavLinks } from './NavLinks';
import { ThemeToggle } from './ThemeToggle';
import { TokenPrice } from './TokenPrice';
import { WalletButton } from './WalletButton';

/** The sticky top bar from the prototype: brand, nav pills, search, token price, X, Telegram, theme, credits, wallet. */
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
          <a className="icon-btn top-x" href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="ApeCheck on X">
            <XLogoIcon />
          </a>
          <a className="icon-btn top-x top-tg" href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" aria-label="ApeCheck on Telegram">
            <TelegramIcon />
          </a>
          <ThemeToggle />
          <CreditsButton />
          <WalletButton />
        </div>
      </div>
      <NavLinks className="nav-m" id="navm" />
    </header>
  );
}
