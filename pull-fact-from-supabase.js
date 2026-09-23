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
    if (!r) continue; // ещё не считалось (рано, вне текущего окна и т.п.)

    // Ничего в существующих полях (manualContribution, plannedContribution, noImpact)
    // не трогаем — авто-расчёт кладётся в отдельные поля, только для сверки.
    deal.autoContributionUnits = r.auto_contribution_units === null ? null : Number(r.auto_contribution_units);
    deal.autoContributionKzt = r.auto_contribution_kzt === null ? null : Number(r.auto_contribution_kzt);
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
