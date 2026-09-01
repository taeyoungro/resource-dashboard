import { createRequire } from 'node:module';
const require = createRequire('/home/user/resource-dashboard/package.json');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
globalThis.React = React;

const { PolicyTopology } = await import('./Topology.js');

const group = (resource_type, total, extra = {}) => ({
  service: 'ec2', resource_type, actions: [], scope: '*', total,
  truncated: false, sensitive_hits: 0, resources: [], ...extra,
});
const pol = (affected) => ({ identifier: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess', affected });

const render = (affected) => renderToStaticMarkup(
  React.createElement(PolicyTopology, { policy: pol(affected), name: 'AmazonEC2FullAccess', accountId: '718100330247' }),
);

const which = process.argv[2];

if (which === 'sensitive') {
  const html = render([group('ec2:security-group', 3, { sensitive_hits: 3 }), group('ec2:instance', 5)]);
  const html2 = render([group('ec2:security-group', 3), group('ec2:instance', 5)]);
  const pick = (h) => [...h.matchAll(/<g class="topo-frame-(sg|vpc|subnet)"[\s\S]*?<\/g>/g)].map(m => m[0]);
  console.log('--- sensitive_hits 3 ---');
  console.log(pick(html).join('\n'));
  console.log('--- sensitive_hits 0 ---');
  console.log(pick(html2).join('\n'));
  console.log('IDENTICAL sg markup:', pick(html)[0] === pick(html2)[0].replace('3개*','3개*'));
  console.log('\n--- sensitive VPC group ---');
  const html3 = render([group('ec2:vpc', 2, { sensitive_hits: 2 })]);
  console.log(pick(html3).join('\n'));
  console.log('any topo-slot-sensitive?', /topo-slot-sensitive/.test(html3));
  console.log('table sensitive cell:', /<td class="sensitive">/.test(html3));
}

if (which === 'omitted') {
  const html = renderToStaticMarkup(React.createElement(PolicyTopology, {
    policy: { identifier: 'AmazonEC2FullAccess', affected: [
      group('ec2:instance', 5),
      { service: 'elasticloadbalancing', resource_type: 'elasticloadbalancing:loadbalancer', total: 30, truncated: false, sensitive_hits: 0, scope: '*', resources: [] },
      { service: 'rds', resource_type: 'rds:db', total: 4, truncated: false, sensitive_hits: 0, scope: '*', resources: [] },
    ] }, name: 'AmazonEC2FullAccess', accountId: 'A',
  }));
  const i = html.indexOf('그림 밖 서비스 2종');
  console.log('foot text present at', i);
  const t0 = html.indexOf('<table');
  const t1 = html.indexOf('</table>');
  console.log('table span', t0, t1);
  console.log('TABLE CONTENT:\n', html.slice(t0, t1 + 8));
  console.log('AFTER TABLE:\n', html.slice(t1 + 8, t1 + 400));
}

if (which === 'empty') {
  const html = render([]);
  console.log(html.replace(/></g, '>\n<').split('\n').filter(l => /topo-frame-note|topo-foot|desc|muted small">\s*EC2|EC2 자원/.test(l)).join('\n'));
  console.log('--- closed summary span ---');
  const m = html.match(/<span class="muted small">[\s\S]*?<\/span>/);
  console.log(m && m[0]);
}

if (which === 'dupnode') {
  const html = render([group('ec2:instance', 40), group('ec2:instance', 7)]);
  console.log([...html.matchAll(/<text class="topo-slot-count"[^>]*>([^<]*)<\/text>/g)].map(m=>m[1]));
  console.log('rows:', [...html.matchAll(/<td><code>([^<]*)<\/code><\/td>/g)].map(m=>m[1]));
}
