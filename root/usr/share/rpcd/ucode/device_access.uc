// SPDX-License-Identifier: GPL-2.0-only

'use strict';

import { connect } from 'ubus';
import { cursor } from 'uci';

const rtnl = require('rtnl');
const rt = rtnl.const;

function stringList(value) {
	return type(value) == 'array' ? value : split(value || '', / +/);
}

function clientInterfaces() {
	const config = cursor();
	const wan = config.get('device_access', 'main', 'zone') || 'wan';
	const sources = { lan: true };
	config.foreach('firewall', 'forwarding', (entry) => {
		if (entry.dest == wan && entry.src && entry.enabled != '0')
			sources[entry.src] = true;
	});
	delete sources[wan];

	const interfaces = {};
	const conn = connect();
	const status = conn?.call('network.interface', 'dump')?.interface ?? [];
	for (let iface in status)
		if (iface.up && iface.l3_device)
			interfaces[iface.interface] = iface.l3_device;

	const devices = {};
	config.foreach('firewall', 'zone', (zone) => {
		if (!sources[zone.name])
			return;
		for (let name in stringList(zone.network))
			if (interfaces[name])
				devices[interfaces[name]] = true;
		for (let device in stringList(zone.device))
			if (device)
				devices[device] = true;
	});
	return devices;
}

function getClients() {
	const devices = clientInterfaces();
	const entries = rtnl.request(rt.RTM_GETNEIGH, rt.NLM_F_REQUEST | rt.NLM_F_DUMP,
		{ family: rt.AF_UNSPEC });
	if (type(entries) != 'array')
		return { clients: null };

	const clients = {};
	const valid = rt.NUD_REACHABLE | rt.NUD_STALE | rt.NUD_DELAY | rt.NUD_PROBE;
	for (let entry in entries) {
		if (!devices[entry.dev] || !(entry.state & valid) || (entry.flags & rt.NTF_PROXY))
			continue;
		const mac = lc(entry.lladdr || '');
		if (!match(mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) ||
		    (entry.family != rt.AF_INET && entry.family != rt.AF_INET6) || !entry.dst)
			continue;

		const client = clients[mac] ??= { mac, ipv4: [], ipv6: [], reachable: false };
		const addresses = entry.family == rt.AF_INET ? client.ipv4 : client.ipv6;
		if (!(entry.dst in addresses))
			push(addresses, entry.dst);
		if (entry.state & rt.NUD_REACHABLE)
			client.reachable = true;
	}

	return { clients: map(keys(clients), (mac) => clients[mac]) };
}

return { 'luci.device_access': { clients: { call: getClients } } };
