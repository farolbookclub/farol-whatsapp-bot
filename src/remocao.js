import { supabase } from './supabase.js'
import { enviarMsg } from './envio.js'

// Processa pedidos de remoção vindos do cancelamento de inscrição no painel
// admin (fica a cargo do bot porque ele roda no celular, sem endereço
// público — não dá pra chamar na hora). Tira a pessoa de todos os grupos
// ativos e desvincula o número. Re-entrada fica bloqueada naturalmente: o
// join-request só aprova quem está com inscrição aprovada.
// Mensagem pra pessoa quando a admin cancela a inscrição por quebra de
// regra — nada é dito pra saída voluntária ou "outro motivo" (ela decide
// se fala por fora).
function diasSemInteragir(membro) {
  const referencia = [membro?.ultima_interacao, membro?.entrou_em].filter(Boolean).sort().at(-1)
  if (!referencia) return null
  return Math.round((Date.now() - Date.parse(`${referencia}T00:00:00Z`)) / 86400000)
}

function textoQuebraRegra(regra, membro) {
  if (regra === '3_encontros') {
    return 'Você foi removida do Farol por faltar a 3 encontros presenciais seguidos. Para voltar, faça uma nova inscrição. ' +
      'A entrada na modalidade presencial depende de vaga disponível. Obrigada por ter feito parte! 💕'
  }
  if (regra === 'ausencia_virtual') {
    const dias = diasSemInteragir(membro)
    return `Você foi removida do Farol porque ficou${dias ? ` ${dias} dias` : ' um tempo'} sem participar dos grupos. ` +
      'Quando quiser voltar, é só fazer uma nova inscrição. Obrigada pelo tempo com a gente! 💕'
  }
  if (regra === 'desrespeito') {
    return 'Você foi removida do Farol por descumprir as regras de convivência da comunidade. Agradecemos a compreensão.'
  }
  return null // "outro": só manda se a admin escreveu uma mensagem personalizada (ver pedido.mensagem_personalizada).
}

export async function processarRemocoesPendentes(sock) {
  const { data: pedido } = await supabase
    .from('whatsapp_remocoes')
    .select('id, signup_id, motivo, regra, enviar_mensagem, mensagem_personalizada')
    .eq('status', 'pendente')
    .order('criado_em', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pedido) return

  await supabase.from('whatsapp_remocoes').update({ status: 'processando' }).eq('id', pedido.id)

  try {
    const { data: membro } = await supabase
      .from('whatsapp_membros')
      .select('jid, ultima_interacao, entrou_em')
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

      if (pedido.motivo === 'quebra_regra' && pedido.enviar_mensagem !== false) {
        const texto = pedido.regra === 'outro' ? pedido.mensagem_personalizada || null : textoQuebraRegra(pedido.regra, membro)
        if (texto) {
          try {
            await enviarMsg(sock, membro.jid, { text: texto })
          } catch (erro) {
            console.error(`aviso de remoção por quebra de regra ${membro.jid}:`, erro)
          }
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
