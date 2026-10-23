import { lazy, Suspense, useEffect, useState } from "react";
import { MenuIcon, MoonIcon, SunIcon, SystemIcon } from "./components/Icons";
import { Logo } from "./components/Logo";
import { Home } from "./pages/Home";
import { Link, usePath } from "./router";
import { type ThemeChoice, useThemeChoice } from "./theme";

const BookHealth = lazy(() =>
  import("./pages/BookHealth").then((m) => ({ default: m.BookHealth })),
);
const Judge = lazy(() => import("./pages/Judge").then((m) => ({ default: m.Judge })));
const Conduct = lazy(() => import("./pages/Conduct").then((m) => ({ default: m.Conduct })));
const Policies = lazy(() => import("./pages/Policies").then((m) => ({ default: m.Policies })));
const Makers = lazy(() => import("./pages/Makers").then((m) => ({ default: m.Makers })));

const NAV = [
  { to: "/", label: "Book" },
  { to: "/book-health", label: "Book Health" },
  { to: "/judge", label: "Judge mode" },
  { to: "/conduct", label: "Conduct" },
  { to: "/policies", label: "Policies" },
  { to: "/makers", label: "Makers" },
];

const TITLES: Record<string, string> = {
  "/": "Ballast · covered liquidity for Strike",
  "/book-health": "Book Health · Ballast",
  "/judge": "Judge mode · Ballast",
  "/conduct": "Proof of Conduct · Ballast",
  "/policies": "Policies · Ballast",
  "/makers": "Makers · Ballast",
};

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "dark",
  dark: "light",
  light: "system",
};

function ThemeButton() {
  const [choice, setChoice] = useThemeChoice();
  const Icon = choice === "dark" ? MoonIcon : choice === "light" ? SunIcon : SystemIcon;
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => setChoice(NEXT_THEME[choice])}
      aria-label={`Theme: ${choice}. Switch to ${NEXT_THEME[choice]}.`}
      title={`Theme: ${choice}`}
    >
      <Icon />
    </button>
  );
}

function Page({ path }: { path: string }) {
  switch (path) {
    case "/":
      return <Home />;
    case "/book-health":
      return <BookHealth />;
    case "/judge":
      return <Judge />;
    case "/conduct":
      return <Conduct />;
    case "/policies":
      return <Policies />;
    case "/makers":
      return <Makers />;
    default:
      return (
        <div className="page-head">
          <p className="overline">404</p>
          <h1>Nothing is moored here.</h1>
          <p className="lede">
            That page does not exist. <Link to="/">Back to the book</Link>.
          </p>
        </div>
      );
  }
}

export function App() {
  const path = usePath();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    document.title = TITLES[path] ?? "Ballast";
    setMenu(false);
  }, [path]);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="wrap">
          <Link to="/" className="brand" aria-label="Ballast, home">
            <Logo />
            Ballast
          </Link>
          <nav className="nav" aria-label="Primary">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="header-actions">
            <ThemeButton />
            <button
              type="button"
              className="icon-btn menu-btn"
              aria-expanded={menu}
              aria-controls="mobile-nav"
              onClick={() => setMenu((m) => !m)}
            >
              <MenuIcon />
              Menu
            </button>
          </div>
        </div>
        {menu ? (
          <nav id="mobile-nav" className="mobile-nav" aria-label="Primary">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to}>
                {n.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>
      <main id="main" className="wrap">
        <Suspense fallback={<div className="page-head" aria-busy="true" />}>
          <Page path={path} />
        </Suspense>
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <div className="footer-links">
            <Link to="/book-health#methodology">Methodology</Link>
            <Link to="/judge">Verify the recordings</Link>
            <a href="/api/health">API status</a>
          </div>
          <p>
            Ballast reads only Strike's public market data and never publishes order ids, account
            ids, addresses, leverage or liquidation prices of anyone. Live positions appear only as
            aggregate counts.
          </p>
          <p>
            Charts by{" "}
            <a href="https://www.tradingview.com/lightweight-charts/" rel="noreferrer">
              TradingView Lightweight Charts™
            </a>{" "}
            (Apache-2.0). Ballast is an independent project, not affiliated with Strike Finance.
          </p>
        </div>
      </footer>
    </>
  );
}
