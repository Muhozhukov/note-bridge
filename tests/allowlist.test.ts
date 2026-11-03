import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allowedEmails,permittedEmail} from '../auth-service/src/allowlist';
test('single and multiple email configuration remain compatible',()=>{
 assert.deepEqual(allowedEmails('Owner@Example.com'),['owner@example.com']);
 assert.deepEqual(allowedEmails(' owner@example.com, Wife@Example.com;\nowner@example.com\r\n'),['owner@example.com','wife@example.com']);
});
test('invalid and wildcard configuration fails closed',()=>{
 for(const s of [undefined,'',' , ;\n','*','*@example.com','owner@example.com,broken','owner@example.com wife@example.com','name <owner@example.com>','x'.repeat(16385)])assert.deepEqual(allowedEmails(s),[]);
 assert.deepEqual(allowedEmails(Array(101).fill('owner@example.com').join(',')),[]);
});
test('only exact verified addresses are admitted',async()=>{
 const config='owner@example.com,wife@example.com';
 assert.equal(await permittedEmail(config,'OWNER@example.com',true),true);
 assert.equal(await permittedEmail(config,'wife@example.com',true),true);
 for(const email of ['stranger@example.com','wife@example.com.evil','notwife@example.com','wife+tag@example.com','wife@example.com '])assert.equal(await permittedEmail(config,email,true),false);
 for(const verified of [false,undefined,'true',1])assert.equal(await permittedEmail(config,'wife@example.com',verified),false);
 assert.equal(await permittedEmail(config,null,true),false);
});
