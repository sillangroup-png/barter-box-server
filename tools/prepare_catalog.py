"""Read source spreadsheets, join exact identifiers; never match product names heuristically."""
import argparse,csv,json,collections
from pathlib import Path
from decimal import Decimal
from openpyxl import load_workbook

def stringify(v):
 if v is None:return ''
 if isinstance(v,(int,float)):return format(Decimal(str(v)).normalize(),'f')
 return str(v).strip()
def rows(path):
 sheet=load_workbook(path,read_only=True,data_only=True).worksheets[0]
 data=sheet.iter_rows(values_only=True); headers=[stringify(x) for x in next(data)]
 return [dict(zip(headers,[stringify(x) for x in row])) for row in data if any(x is not None for x in row)]
def main():
 p=argparse.ArgumentParser();p.add_argument('--cost',required=True);p.add_argument('--kaspi',required=True);p.add_argument('--out',required=True);a=p.parse_args()
 out=Path(a.out);out.mkdir(parents=True,exist_ok=True);costs=rows(a.cost);kaspi=rows(a.kaspi)
 index=collections.defaultdict(list)
 for k in kaspi:
  if k.get('sku_merch'):index[k['sku_merch']].append(k)
 products=[];review=[];duplicates=[];seen={};stats=collections.Counter()
 for r in costs:
  if not r.get('Наименование') or not r.get('Штрихкод'):review.append({'reason':'missing_identifier_or_name','source':r});continue
  barcode=r['Штрихкод'];sku=r.get('SKU','');article=r.get('Артикул','')
  if barcode in seen:
   duplicates.append({'barcode':barcode,'first':seen[barcode],'duplicate':r});continue
  seen[barcode]=r
  candidates={k['sku']:k for ident in (barcode,sku,article) for k in index.get(ident,[]) if k.get('sku')}
  active={k:v for k,v in candidates.items() if v.get('в продаже')=='1' and v.get('merch_is_active')=='1'}
  # One active listing is usable; more than one requires explicit mapping.
  selected=next(iter(active)) if len(active)==1 else ''
  status='matched_active' if selected else 'multiple_active' if len(active)>1 else 'inactive_only' if candidates else 'unmatched'
  stats[status]+=1
  cost=r.get('Усл. себес.','')
  item={'name':r['Наименование'],'barcode':barcode,'sku':sku,'internal_article':article,'cost_kzt':cost,
   'kaspi_article':selected,'mapping_status':status,'kaspi_candidates':list(candidates),'source_file':Path(a.cost).name,'currency':'KZT'}
  products.append(item)
  if status!='matched_active':review.append({'barcode':barcode,'sku':sku,'name':item['name'],'reason':status,'candidates':[{'article':k,'merchant_sku':v['sku_merch'],'in_sale':v.get('в продаже'),'merchant_active':v.get('merch_is_active')} for k,v in candidates.items()]})
 (out/'catalog.json').write_text(json.dumps(products,ensure_ascii=False,indent=2))
 fields=['name','barcode','sku','internal_article','cost_kzt','kaspi_article','mapping_status']
 with (out/'catalog.csv').open('w',newline='',encoding='utf-8-sig') as f:
  w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore');w.writeheader();w.writerows(products)
 report={'cost_source_rows':len(costs),'kaspi_source_rows':len(kaspi),'unique_products':len(products),'mapping':dict(stats),'duplicate_barcodes':len(duplicates),'currency':'KZT','currency_confirmed_by_user':True,'matching':'exact barcode / SKU / internal article to sku_merch; no fuzzy names','stock_note':'в продаже is a listing flag, not a stock quantity'}
 (out/'catalog-report.json').write_text(json.dumps({'summary':report,'review':review,'duplicates':duplicates},ensure_ascii=False,indent=2))
 print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
