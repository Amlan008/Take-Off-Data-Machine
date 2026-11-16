"""Offline regression fixtures, not current cyclone observations."""
import ast
from pathlib import Path
import unittest


source = ast.parse((Path(__file__).resolve().parents[1] / 'server.py').read_text())
namespace = {}
exec(compile(ast.Module(body=[node for node in source.body if isinstance(node, (ast.Import, ast.ImportFrom)) or isinstance(node, ast.ClassDef) and node.name == 'AppHandler'], type_ignores=[]), 'server.py', 'exec'), namespace)
Handler = namespace['AppHandler']


def bulletin(name='FIXTURE', hemisphere='S', forecasts=True):
    text = f'''SUBJ/TROPICAL CYCLONE 04P ({name}) WARNING NR 001
WARNING POSITION:
160000Z --- NEAR 12.0{hemisphere} 170.0E
PRESENT WIND DISTRIBUTION:
MAX SUSTAINED WINDS - 040 KT, GUSTS 050 KT
'''
    if forecasts:
        text += f'''12 HRS, VALID AT:
161200Z --- 13.0{hemisphere} 171.0E
MAX SUSTAINED WINDS - 045 KT, GUSTS 055 KT
'''
    return text.encode()


def item(category, products, graphic=True):
    links = ''.join(f'<a href="https://www.metoc.navy.mil/jtwc/products/{p}web.txt">TC Warning Text</a>' + (f'<a href="https://www.metoc.navy.mil/jtwc/products/{p}.gif">TC Warning Graphic</a>' if graphic else '') for p in products)
    return f'<item><category>{category}</category><description><![CDATA[{links}]]></description></item>'


class StormFeeds(unittest.TestCase):
    def load(self, items, broken=(), forecasts=True):
        handler = Handler.__new__(Handler)
        calls = []
        def fetch(url):
            calls.append(url)
            if url.endswith('.rss'):
                return ('<rss><channel>' + ''.join(items) + '</channel></rss>').encode()
            if any(p in url for p in broken):
                raise OSError('fixture unavailable')
            return bulletin(forecasts=forecasts)
        handler.fetch_body = fetch
        return handler.jtwc_warnings(), calls

    def test_all_supported_basins_and_nhc_precedence(self):
        data, calls = self.load([item('Southern Hemisphere', ['sh0427']), item('North Indian Ocean', ['io0526']), item('Northwest Pacific', ['wp2826']), item('Eastern Pacific', ['ep2026']), item('Formation alerts', ['sh9027'])])
        self.assertEqual([s['basin'] for s in data['systems']], ['Southern Hemisphere', 'North Indian Ocean', 'Western Pacific'])
        self.assertEqual(len(calls), 4)
        self.assertEqual(data['warnings'], [])
        self.assertEqual(data['systems'][0]['position']['lat'], -12)
        self.assertEqual(data['systems'][0]['forecast'][0]['lat'], -13)
        self.assertEqual(data['systems'][0]['forecast'][0]['intensity'], 45)

    def test_graphic_is_optional_and_duplicates_do_not_refetch(self):
        data, calls = self.load([item('Southern Hemisphere', ['sh0427', 'sh0427'], graphic=False)])
        self.assertEqual(len(data['systems']), 1)
        self.assertIsNone(data['systems'][0]['graphic_url'])
        self.assertEqual(len(calls), 2)

    def test_one_failed_product_preserves_others_and_reports_partial(self):
        data, _ = self.load([item('Southern Hemisphere', ['sh0427', 'sh0527'])], broken=['sh0427'])
        self.assertEqual(len(data['systems']), 1)
        self.assertIn('SH0427', data['warnings'][0])

    def test_final_warning_without_forecast_is_explicit(self):
        data, _ = self.load([item('Southern Hemisphere', ['sh0427'])], forecasts=False)
        self.assertEqual(len(data['systems']), 1)
        self.assertIn('no forecast positions', data['warnings'][0])


if __name__ == '__main__':
    unittest.main()
