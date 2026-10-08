/** Junta classes ignorando valores vazios. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/*
 * Camadas (z-index) usadas no app:
 *   10 barras fixas da página
 *   20 controles do palco
 *   30 bandeja de importações
 *   40 fundo de diálogo
 *   50 diálogos e menus
 *   60 avisos (toasts)
 *   70 dicas (tooltips)
 */
