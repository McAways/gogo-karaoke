/** FFT radix-2 iterativa, in-place. O tamanho precisa ser potência de 2. */
export class FFT {
  readonly size: number
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly reversed: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT: o tamanho precisa ser potência de 2')
    this.size = size
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      const angle = (-2 * Math.PI * i) / size
      this.cos[i] = Math.cos(angle)
      this.sin[i] = Math.sin(angle)
    }

    const bits = Math.log2(size)
    this.reversed = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.reversed[i] = r
    }
  }

  transform(re: Float64Array, im: Float64Array): void {
    const { size, cos, sin, reversed } = this

    for (let i = 0; i < size; i++) {
      const j = reversed[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }

    for (let half = 1; half < size; half <<= 1) {
      const step = size / (half << 1)
      for (let start = 0; start < size; start += half << 1) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k
          const b = a + half
          const xr = re[b] * cos[t] - im[b] * sin[t]
          const xi = re[b] * sin[t] + im[b] * cos[t]
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}
