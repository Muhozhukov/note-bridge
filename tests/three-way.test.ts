import {test} from 'node:test';import assert from 'node:assert/strict';import {threeWay} from '../core/three-way';
test('independent edits combine with original line endings',()=>{assert.equal(threeWay('a\r\nb\r\nc\r\nd\r\n','A\r\nb\r\nc\r\nd\r\n','a\r\nb\r\nc\r\nD\r\n'),'A\r\nb\r\nc\r\nD\r\n');});
test('overlapping and touching edits require review',()=>{assert.equal(threeWay('a\nb\nc\n','X\nb\nc\n','Y\nb\nc\n'),undefined);assert.equal(threeWay('a\nb\nc\n','X\nb\nc\n','a\nY\nc\n'),undefined);});
test('same changes and one unchanged side converge',()=>{assert.equal(threeWay('old','new','new'),'new');assert.equal(threeWay('old','old','new'),'new');assert.equal(threeWay('old','new','old'),'new');});
test('deletion and distant insertion combine, competing inserts are not guessed',()=>{assert.equal(threeWay('a\nb\nc\nd\n','b\nc\nd\n','a\nb\nc\nd\ne\n'),'b\nc\nd\ne\n');assert.equal(threeWay('a\n','x\na\n','y\na\n'),undefined);});
