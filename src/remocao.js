import { supabase } from './supabase.js'

// Processa pedidos de remoção vindos do cancelamento de inscrição no painel
// admin (fica a cargo do bot porque ele roda no celular, sem endereço
// público — não dá pra chamar na hora). Tira a pessoa de todos os grupos
// ativos e desvincula o número. Re-entrada fica bloqueada naturalmente: o
// join-request só aprova quem está com inscrição aprovada.
// Mensagem pra pessoa quando a admin cancela a inscrição por quebra de
// regra — nada é dito pra saída voluntária ou "outro motivo" (ela decide
// se fala por fora).
function textoQuebraRegra(regra, detalhe) {
  if (regra === '3_encontros') {
    return 'Você foi removida do Farol por ter faltado a 3 encontros presenciais sem avisar. ' +
      'Se quiser voltar algum dia, é só fazer uma nova inscrição 💕'
  }
  if (regra === 'ausencia_virtual') {
    return 'Você foi removida do Farol por ficar muito tempo sem participar/interagir nos grupos. ' +
      'Se quiser voltar algum dia, é só fazer uma nova inscrição 💕'
  }
  if (regra === 'desrespeito') {
    return 'Você foi removida do Farol por não respeitar as regras de convivência da comunidade.' +
      (detalhe && detalhe !== 'Desrespeito' ? `\n\nMotivo: ${detalhe}` : '')
  }
  return `Você foi removida do Farol.${detalhe ? `\n\nMotivo: ${detalhe}` : ''}`
}

export async function processarRemocoesPendentes(sock) {
  const { data: pedido } = await supabase
    .from('whatsapp_remocoes')
    .select('id, signup_id, motivo, regra, detalhe')
    .eq('status', 'pendente')
    .order('criado_em', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pedido) return

  await supabase.from('whatsapp_remocoes').update({ status: 'processando' }).eq('id', pedido.id)

  try {
    const { data: membro } = await supabase
      .from('whatsapp_membros')
      .select('jid')
      .eq('signup_id', pedido.signup_id)
      .is('removido_em', null)
      .maybeSingle()

    if (membro) {
      const { data: grupos } = await supabase.from('whatsapp_grupos').select('group_jid, nome').eq('ativo', true)
      for (const g of grupos ?? []) {
        try {
          await sock.groupParticipantsUpdate(g.group_jid, [membro.jid], 'remove')
        } catch (erro) {
          // Pode já não estar no grupo: não é erro fatal, só loga.
          console.error(`remover de ${g.nome}:`, erro)
        }
      }
      await supabase
        .from('whatsapp_membros')
        .update({ removido_em: new Date().toISOString().slice(0, 10), signup_id: null })
        .eq('jid', membro.jid)

      if (pedido.motivo === 'quebra_regra') {
        try {
          await sock.sendMessage(membro.jid, { text: textoQuebraRegra(pedido.regra, pedido.detalhe) })
        } catch (erro) {
          console.error(`aviso de remoção por quebra de regra ${membro.jid}:`, erro)
        }
      }
    }

    await supabase.from('whatsapp_remocoes').update({ status: 'concluido', concluido_em: new Date().toISOString() }).eq('id', pedido.id)
  } catch (erro) {
    console.error('processarRemocoesPendentes:', erro)
    await supabase
      .from('whatsapp_remocoes')
      .update({ status: 'erro', erro: erro?.message || 'falha desconhecida', concluido_em: new Date().toISOString() })
      .eq('id', pedido.id)
  }
}
