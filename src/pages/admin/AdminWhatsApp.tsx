import { Navigate } from "react-router-dom";
import { ROUTES } from "@/lib/routes";

/**
 * /admin/whatsapp is now integrated as a sub-tab inside /admin/mensagens.
 * Redirect so any bookmarks / links continue to work.
 */
export default function AdminWhatsApp() {
  return <Navigate to={`${ROUTES.admin.mensagens}?tab=whatsapp`} replace />;
}
