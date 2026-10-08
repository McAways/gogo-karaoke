import { create } from 'zustand'

export interface Toast {
  id: number
  text: string
  tone: 'ok' | 'erro'
}

interface ToastStore {
  toasts: Toast[]
  push: (text: string, tone?: Toast['tone']) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastStore>()((set, get) => ({
  toasts: [],
  push(text, tone = 'ok') {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts.slice(-2), { id, text, tone }] }))
    setTimeout(() => get().dismiss(id), tone === 'erro' ? 7000 : 4000)
  },
  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  },
}))

export const toast = (text: string, tone?: Toast['tone']) => useToasts.getState().push(text, tone)
