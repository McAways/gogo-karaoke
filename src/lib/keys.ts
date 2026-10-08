/** true quando a tecla foi digitada num campo de texto, e por isso não é atalho. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
}

/**
 * Impede que a barra de espaço acione o botão que estiver com o foco.
 *
 * No palco e no editor o espaço tem uma função fixa (tocar, marcar a linha). Quem
 * acabou de clicar num botão não percebe que o foco ficou nele, e o espaço acabaria
 * repetindo aquele clique. Os botões continuam acionáveis com Enter.
 * Devolve a função que desfaz o registro.
 */
export function reserveSpaceKey(): () => void {
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== ' ' || isTyping(event)) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, [role="button"]')) event.preventDefault()
  }
  window.addEventListener('keyup', onKeyUp, true)
  return () => window.removeEventListener('keyup', onKeyUp, true)
}
