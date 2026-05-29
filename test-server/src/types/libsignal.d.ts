declare module 'libsignal' {
  export const curve: {
    generateKeyPair(): { pubKey: Uint8Array; privKey: Uint8Array }
    calculateAgreement(pub: Uint8Array, priv: Uint8Array): Uint8Array
    calculateSignature(priv: Uint8Array, msg: Uint8Array): Uint8Array
    verifySignature(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean
  }
  // Allow any other named exports without typing.
  const _default: unknown
  export default _default
}
