import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon, type IconName } from '../components/Icon';
import { Avatar, Button } from '../components/ui';

const NAV: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: '/', label: 'Mascotas', icon: 'paw', end: true },
  { to: '/agenda', label: 'Agenda', icon: 'calendar' },
  { to: '/sales', label: 'Ventas', icon: 'tag' },
  { to: '/catalog', label: 'Catálogo', icon: 'box' },
  { to: '/inbox', label: 'Bandeja', icon: 'chat' },
  { to: '/ai', label: 'IA', icon: 'sparkle' },
];

function titleFor(pathname: string): { title: string; subtitle: string } {
  if (pathname.startsWith('/pets/')) {
    return { title: 'Ficha de la mascota', subtitle: 'Historial, citas y compras' };
  }
  if (pathname === '/') {
    return { title: 'Mascotas', subtitle: 'El centro del CRM' };
  }
  if (pathname.startsWith('/clients/')) {
    return { title: 'Ficha del cliente', subtitle: 'Datos y mascotas' };
  }
  if (pathname.startsWith('/clients')) {
    return { title: 'Clientes', subtitle: 'Propietarios y sus mascotas' };
  }
  if (pathname.startsWith('/catalog')) {
    return { title: 'Catálogo', subtitle: 'Servicios y artículos' };
  }
  if (pathname.startsWith('/sales/new')) {
    return { title: 'Nueva venta', subtitle: 'Servicios y artículos' };
  }
  if (pathname.includes('/edit')) {
    return { title: 'Editar venta', subtitle: 'Corregir conceptos y totales' };
  }
  if (pathname.startsWith('/sales/')) {
    return { title: 'Venta', subtitle: 'Detalle y pagos' };
  }
  if (pathname.startsWith('/sales')) {
    return { title: 'Ventas', subtitle: 'Ingresos, egresos y ventas' };
  }
  if (pathname.startsWith('/inbox')) {
    return { title: 'Bandeja', subtitle: 'Conversaciones de WhatsApp' };
  }
  if (pathname.startsWith('/ai')) {
    return { title: 'Sugerencias de IA', subtitle: 'Revisión de datos extraídos' };
  }
  return { title: 'Agenda', subtitle: 'Citas del día y de la semana' };
}

export function AppLayout() {
  const { user, business, logout } = useAuth();
  const { pathname } = useLocation();
  const { title, subtitle } = titleFor(pathname);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src="/branding/keyko-mark.png" alt="" />
          </span>
          <span className="brand-text">
            <strong>Keyko CRM</strong>
            <span>{business?.name ?? 'Pet Shop & Grooming'}</span>
          </span>
        </div>

        <nav className="col" style={{ gap: 2 }}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} size={19} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="who">
            <Avatar name={user?.name ?? user?.email ?? null} size={34} />
            <div className="who-text">
              <strong>{user?.name ?? 'Administrador'}</strong>
              <span>{user?.email}</span>
            </div>
          </div>
          <Button variant="subtle" icon="logout" onClick={logout}>
            Cerrar sesión
          </Button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <img className="topbar-mark" src="/branding/keyko-mark.png" alt="" />
          <div className="topbar-title">
            <h1>{title}</h1>
            <span>{subtitle}</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="muted small hide-sm">{business?.timezone}</span>
            <Button
              variant="subtle"
              icon="logout"
              onClick={logout}
              aria-label="Cerrar sesión"
              className="mobile-only"
            />
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Navegación principal">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            <Icon name={item.icon} size={20} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
