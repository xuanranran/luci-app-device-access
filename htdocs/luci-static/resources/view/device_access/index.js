'use strict';
'require view';
'require form';
'require uci';
'require network';
'require rpc';
'require ui';

const listClients = rpc.declare({
	object: 'luci.device_access',
	method: 'clients'
});

function fetchClients() {
	return L.resolveDefault(listClients().then(result => result.clients), null);
}

function renderClients(map, rules, data, names) {
	const makeButton = (label, mode, client, name) => E('button', {
		'type': 'button',
		'class': 'btn cbi-button',
		'disabled': map.readonly || null,
		'click': ui.createHandlerFn(rules, 'editClient', client, name, mode)
	}, [ label ]);
	const table = E('table', { 'class': 'table' }, [
		E('tr', { 'class': 'tr table-titles' }, [
			_('Device name'), _('IP address'), _('Device MAC address'), _('Connection'), _('Actions')
		].map(label => E('th', { 'class': 'th' }, [ label ])))
	]);
	function update(clients) {
		const rows = (clients || []).map(client => ({ client, name: names.get(client.mac) || '' }))
			.sort((a, b) => Number(b.client.reachable) - Number(a.client.reachable) ||
				a.name.localeCompare(b.name) || a.client.mac.localeCompare(b.client.mac));
		cbi_update_table(table, rows.map(({ client, name }) => [
			E('span', {}, [ name || '–' ]),
			E('span', {}, [ (client.ipv4.length ? client.ipv4 : client.ipv6).join(', ') ]),
			E('code', {}, [ client.mac ]),
			E('span', {}, [ client.reachable ? _('Reachable') : _('Connection unconfirmed') ]),
			E('div', {}, [
				makeButton(_('Block internet'), 'always', client, name), ' ',
				makeButton(_('Set internet schedule'), 'outside', client, name)
			])
		]), E('em', {}, [ clients ? _('No connected devices detected.') : _('Could not load connected devices.') ]));
	}
	update(data[3]);
	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, [ _('Connected devices') ]),
		E('div', { 'class': 'cbi-section-descr' }, [
			_('Devices detected by the router. Refresh to check for changes.')
		]),
		table,
		E('div', { 'class': 'cbi-section-actions' }, [
			E('button', {
				'type': 'button',
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(null, () => fetchClients().then(clients => update(data[3] = clients)))
			}, [ _('Refresh') ])
		])
	]);
}

const weekdays = [
	[ '1', _('Mon') ], [ '2', _('Tue') ], [ '3', _('Wed') ],
	[ '4', _('Thu') ], [ '5', _('Fri') ], [ '6', _('Sat') ], [ '0', _('Sun') ]
];

return view.extend({
	load() {
		return Promise.all([
			uci.load('device_access'),
			uci.load('firewall'),
			L.resolveDefault(network.getHostHints(), null),
			fetchClients()
		]);
	},

	render(data) {
		const map = new form.Map('device_access', _('Device Access'),
			_('Restrict internet access by device MAC address. Schedules use the router’s local time.'));
		const settings = map.section(form.NamedSection, 'main', 'defaults', _('Internet destination'));
		const zone = settings.option(form.ListValue, 'zone', _('Firewall zone'),
			_('Only routed traffic to this zone is restricted. Flow offloading and transparent proxies can bypass forwarding rules.'));
		zone.rmempty = false;
		zone.default = 'wan';
		for (const section of uci.sections('firewall', 'zone'))
			if (section.name)
				zone.value(section.name);

		const hints = data[2]?.getMACHints() || [];
		const names = new Map(hints.map(([ mac, name ]) => [ mac.toLowerCase(), name ]));
		const connected = map.section(form.TypedSection, 'device');
		connected.cfgsections = () => [];
		connected.render = () => renderClients(map, rules, data, names);

		const rules = map.section(form.GridSection, 'device', _('Access rules'));
		rules.anonymous = true;
		rules.addremove = true;

		rules.editClient = async function(client, name, mode) {
			await map.parse();
			const matching = uci.sections('device_access', 'device').filter(rule =>
				rule.mac?.toLowerCase() === client.mac);
			const existing = matching.find(rule => (rule.mode || 'always') === 'always') ||
				matching.find(rule => rule.mode === mode) || matching[0];
			const sectionId = existing?.['.name'] || uci.add('device_access', 'device');
			if (!existing)
				map.addedSection = sectionId;

			const defaults = { mac: client.mac, enabled: '1', mode };
			if (name && !existing?.name)
				defaults.name = name;
			return this.renderMoreOptionsModal(sectionId, {
				deviceDefaults: defaults,
				otherRules: matching.length > 1
			});
		};

		rules.addModalOptions = function(section, sectionId, event) {
			const defaults = event?.deviceDefaults;
			if (!defaults)
				return;
			for (const field of section.children) {
				if (Object.prototype.hasOwnProperty.call(defaults, field.option)) {
					field.load = () => defaults[field.option];
					field.forcewrite = true;
				}
			}
			if (event.otherRules)
				section.description = _('Other rules for this device will still apply.');
		};

		let option = rules.option(form.Flag, 'enabled', _('Enable'));
		option.default = option.enabled;
		option.rmempty = false;
		rules.option(form.Value, 'name', _('Device name'));

		option = rules.option(form.Value, 'mac', _('Device MAC address'));
		option.datatype = 'macaddr';
		option.rmempty = false;
		for (const [ mac, hint ] of hints)
			option.value(mac, hint ? '%s (%s)'.format(mac, hint) : mac);

		option = rules.option(form.ListValue, 'mode', _('Policy'));
		option.value('always', _('Always block'));
		option.value('during', _('Block during schedule'));
		option.value('outside', _('Allow only during schedule'));
		option.default = 'always';
		option.rmempty = false;

		function scheduleField(field) {
			field.depends('mode', 'during');
			field.depends('mode', 'outside');
			field.rmempty = false;
			return field;
		}

		option = scheduleField(rules.option(form.MultiValue, 'days', _('Days')));
		for (const [ value, label ] of weekdays)
			option.value(value, label);
		option.default = weekdays.map(([ value ]) => value);

		const start = scheduleField(rules.option(form.Value, 'start', _('Start time')));
		start.placeholder = '08:00';
		const end = scheduleField(rules.option(form.Value, 'end', _('End time'),
			_('An end time before the start continues into the next day.')));
		end.placeholder = '22:00';

		start.validate = end.validate = function(sectionId, value) {
			if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value))
				return _('Use 24-hour HH:MM format.');
			const other = this.section.children.find(field => field.option === (this.option === 'start' ? 'end' : 'start'));
			if (value === other.formvalue(sectionId))
				return _('Start and end must differ.');
			return true;
		};

		return map.render();
	}
});
