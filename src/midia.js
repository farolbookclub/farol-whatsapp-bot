// Monta o conteúdo de uma mensagem do Baileys a partir de um aviso que pode
// (ou não) ter mídia anexada. Com mídia, a legenda vai grudada na mesma
// mensagem (campo "caption"), igual o WhatsApp normal — nunca manda a mídia
// e o texto em mensagens separadas.
export function conteudoMensagem(aviso) {
  if (!aviso.midia_url) return { text: aviso.mensagem }
  if (String(aviso.midia_mime || '').startsWith('image/')) {
    return { image: { url: aviso.midia_url }, mimetype: aviso.midia_mime, caption: aviso.mensagem || undefined }
  }
  return {
    document: { url: aviso.midia_url },
    mimetype: aviso.midia_mime || 'application/octet-stream',
    fileName: aviso.midia_nome || 'arquivo',
    caption: aviso.mensagem || undefined,
  }
}
