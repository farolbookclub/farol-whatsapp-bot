import { supabase } from './supabase.js'
import { normalizarNumero } from './vinculo.js'
import { iniciarGuia } from './guia.js'

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Vincula automaticamente, pelo número de WhatsApp da inscrição, quem ainda
// não vinculou — sem precisar mandar mensagem pro bot. Reaproveita o mesmo
// princípio do vincularPorNumero (feito quando alguém é adicionada na mão),
// só que pra todo mundo de uma vez, pedido pelo painel admin.
export async function autoVincularTodas(sock) {
  const { data: candidatos } = await supabase
    .from('signups')
    .select('id, whatsapp, apelido, nome')
    .eq('status', 'aprovado')
    .not('whatsapp', 'is', null)

  const { data: existentes } = await supabase.from('whatsapp_membros').select('signup_id').is('removido_em', null)
  const idsVinculados = new Set((existentes ?? []).map((m) => m.signup_id))

  const vinculadas = []
  const naoAchou = []

  for (const c of candidatos ?? []) {
    if (idsVinculados.has(c.id)) continue
    const nome = c.apelido || c.nome || '—'
    const numero = normalizarNumero(c.whatsapp)
    if (!numero) {
      naoAchou.push(nome)
      continue
    }
    try {
      const [resultado] = await sock.onWhatsApp(numero)
      if (resultado?.exists) {
        const jid = resultado.lid || resultado.jid
        await supabase
          .from('whatsapp_membros')
          .upsert({ jid, signup_id: c.id, entrou_em: new Date().toISOString().slice(0, 10), guia_etapa: 1, ja_nos_grupos: true }, { onConflict: 'jid' })
        try {
          await iniciarGuia(sock, jid, c.apelido || c.nome, true)
        } catch (erro) {
          console.error(`guia pós-autolink ${nome}:`, erro)
        }
        vinculadas.push(nome)
      } else {
        naoAchou.push(nome)
      }
    } catch (erro) {
      console.error(`autoVincularTodas ${nome}:`, erro)
      naoAchou.push(nome)
    }
    await esperar(1000)
  }

  return { vinculadas, naoAchou }
}

export async function processarAutolinkPendentes(sock) {
  const { data: pedido } = await supabase
    .from('whatsapp_autolink')
    .select('id')
    .eq('status', 'pendente')
    .order('criado_em', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pedido) return

  await supabase.from('whatsapp_autolink').update({ status: 'processando' }).eq('id', pedido.id)

  try {
    const resultado = await autoVincularTodas(sock)
    await supabase
      .from('whatsapp_autolink')
      .update({ status: 'concluido', resultado, concluido_em: new Date().toISOString() })
      .eq('id', pedido.id)
  } catch (erro) {
    console.error('processarAutolinkPendentes:', erro)
    await supabase
      .from('whatsapp_autolink')
      .update({ status: 'erro', erro: erro?.message || 'falha desconhecida', concluido_em: new Date().toISOString() })
      .eq('id', pedido.id)
  }
}
