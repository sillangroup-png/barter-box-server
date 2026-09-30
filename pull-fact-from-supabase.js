// ============================================================================
// pull-fact-from-supabase.js — забирает уже посчитанный attribution.js
// результат обратно в barter-box (в state.influencerDeals И state.microInfluencerDeals),
// чтобы фронтенд мог показать авто-расчёт по Kaspi отдельной колонкой рядом с
// существующим расчётом по salesByDay/1С.
//
// Логика расчёта живёт в Supabase (attribution.js его туда пишет — см.
// 01_migration.sql / attribution.js). Эта функция ничего не считает сама,
// только переносит готовый результат по source_deal_id.
//
// ВАЖНО: крупные и микро/средние интеграции синкаются в influencer_placements
// под РАЗНЫМИ значениями source (проверено в Supabase):
//   source = 'barter_box_deals' -> state.influencerDeals   (tier = 'Крупный')
//   source = 'barter_box_micro' -> state.microInfluencerDeals (tier = 'Малый')
// Раньше эта функция читала только 'barter_box_deals' — микро-сделки авто-расчёт
// никогда не получали. Теперь тянем оба источника.
// ============================================================================

async function pullOne(pgPool, dealsArray, source, { log }) {
  const ids = dealsArray.map((d) => String(d.id));
  if (ids.length === 0) return 0;

  const { rows } = await pgPool.query(
    `SELECT source_deal_id, auto_contribution_units, auto_contribution_kzt,
            auto_contribution_status, auto_contribution_note, auto_contribution_computed_at
     FROM public.influencer_placements
     WHERE source = $1 AND source_deal_id = ANY($2::text[])`,
    [source, ids]
  );

  const byDealId = new Map(rows.map((r) => [r.source_deal_id, r]));
  let updated = 0;

  for (const deal of dealsArray) {
    const r = byDealId.get(String(deal.id));
    // v5: строки в Supabase нет (ещё не синкнулась / удалена) — старый результат в
    // state.json НЕ оставляем: раньше он висел в кэше бессрочно, в т.ч. суммы окна D0–D2.
    if (!r) {
      if (deal.autoContributionStatus != null || deal.autoContributionKzt != null || deal.autoContributionUnits != null) {
        deal.autoContributionUnits = null;
        deal.autoContributionKzt = null;
        deal.autoContributionStatus = null;
        deal.autoContributionNote = null;
        deal.autoContributionComputedAt = null;
        updated++;
      }
      continue;
    }

    // Суммы берём ТОЛЬКО у статусов с числом (ok / zero). У остальных — null,
    // даже если в базе что-то осталось: во фронтенде это «—», а не число.
    const hasNumber = r.auto_contribution_status === "ok" || r.auto_contribution_status === "zero";
    deal.autoContributionUnits = hasNumber && r.auto_contribution_units !== null ? Number(r.auto_contribution_units) : null;
    deal.autoContributionKzt = hasNumber && r.auto_contribution_kzt !== null ? Number(r.auto_contribution_kzt) : null;
    deal.autoContributionStatus = r.auto_contribution_status;
    deal.autoContributionNote = r.auto_contribution_note;
    deal.autoContributionComputedAt = r.auto_contribution_computed_at;
    updated++;
  }

  log(`[pull-fact] ${source}: обновлено ${updated} из ${ids.length}`);
  return updated;
}

async function pullFactFromSupabase(pgPool, state, persist, { log = console.log } = {}) {
  const updatedLarge = await pullOne(pgPool, state.influencerDeals || [], "barter_box_deals", { log });
  const updatedMicro = await pullOne(pgPool, state.microInfluencerDeals || [], "barter_box_micro", { log });
  const updated = updatedLarge + updatedMicro;

  if (updated > 0) persist();
  return { updated, updatedLarge, updatedMicro };
}

module.exports = { pullFactFromSupabase };
