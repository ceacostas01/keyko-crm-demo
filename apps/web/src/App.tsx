import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Spinner } from './components/ui';
import { AppLayout } from './layout/AppLayout';
import { AgendaPage } from './pages/AgendaPage';
import { AiSuggestionsPage } from './pages/AiSuggestionsPage';
import { CatalogPage } from './pages/CatalogPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { ClientsPage } from './pages/ClientsPage';
import { InboxPage } from './pages/InboxPage';
import { LoginPage } from './pages/LoginPage';
import { PetDetailPage } from './pages/PetDetailPage';
import { PetsPage } from './pages/PetsPage';
import { SaleDetailPage } from './pages/SaleDetailPage';
import { SaleEditorPage } from './pages/SaleEditorPage';
import { SalesPage } from './pages/SalesPage';

function Protected({ children }: { children: React.ReactNode }) {
  const { ready, user } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>
        <Spinner label="Cargando Keyko CRM…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <Protected>
            <AppLayout />
          </Protected>
        }
      >
        <Route index element={<PetsPage />} />
        <Route path="pets/:id" element={<PetDetailPage />} />
        <Route path="agenda" element={<AgendaPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="clients/:id" element={<ClientDetailPage />} />
        <Route path="catalog" element={<CatalogPage />} />
        <Route path="sales" element={<SalesPage />} />
        <Route path="sales/new" element={<SaleEditorPage />} />
        <Route path="sales/:id/edit" element={<SaleEditorPage />} />
        <Route path="sales/:id" element={<SaleDetailPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="ai" element={<AiSuggestionsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
