const CONFIG = require('../config');

function cleanupTemplates(text, templatenames) {
  // For each template, create a regular expression to replace
  for (const template of templatenames) {
    const targets = template.from;
    const replacement = template.to;

    for (const target of targets) {
      const regex = new RegExp(`{{\\s*${target}\\s*([|}])`, 'gi');
      text = text.replace(regex, `{{${replacement}$1`);
    }
  }

  return text;
}

function removeTemplates(text, templateNames) {
  const normalized = templateNames.map(n => n.trim().toLowerCase());
  let result = '';
  let i = 0, MAX_ITER = 10000;

  while (i < text.length) {
    // Find the start of a template
    if (text.slice(i, i + 2) === '{{') {
      let start = i;
      let braceCount = 2;
      let end = i + 2;
      let iter = 0;

      // Determine the length of the entire template (considering nesting)
      while (end < text.length && braceCount > 0 && iter++ < MAX_ITER) {
        if (text.slice(end, end + 2) === '{{') {
          braceCount += 2;
          end += 2;
        } else if (text.slice(end, end + 2) === '}}') {
          braceCount -= 2;
          end += 2;
        } else {
          end++;
        }
      }

      if (iter >= MAX_ITER || braceCount > 0) {
        // Prevent infinite loop or unbalanced parentheses → safely add characters one by one
        result += text[i++];
        continue;
      }

      // Extract the entire template
      const templateRaw = text.slice(start, end);

      // Extract the template name ({{name|...) → name
      // This regular expression only works on the beginning of slice templateRaw,
      // so it's fine to use ^ as it is in multi-line body.
      const match = templateRaw.match(/^{{\s*([^|{}\n]+?)([\|}])/);
      const name = match ? match[1].trim().toLowerCase() : null;

      if (name && normalized.includes(name)) {
        // Skip if it's a removal target
        i = end;
      } else {
        // Otherwise, add it as it is
        result += templateRaw;
        i = end;
      }
    } else {
      // If it's not a template, copy it as it is
      result += text[i++];
    }
  }

  return result;
}

function removeCategories(text) {
  try {
    return text.replace(/\[\[Category:.*?\]\]/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (e) {
    console.error('Category removal error:', e);
    return text;
  }
}

function removeItalicsPreserveBold(str) {
  return str.replace(
    /'''''([\s\S]*?)'''''|'''([\s\S]*?)'''|''([\s\S]*?)''/g,
    (match, boldItalic, bold, italic) => {
    if (boldItalic !== undefined) {
      // '''''...''''' → '''...'''
      return `'''${boldItalic}'''`;
    }
    if (bold !== undefined) {
      // '''...''' → keep as it is ('''inner''' will wrap it again)
      return `'''${bold}'''`;
    }
    // ''...'' → inner
    return italic;
    }
  );
}

function replaceTemplates(prompt, templatesArray) {
  // Create a template replacement map (case-insensitive)
  const templateMap = {};
  templatesArray.forEach(line => {
      const [from, to] = line.split('\t');
      if (from && to) {
          templateMap[from.trim().toLowerCase()] = to.trim();
      }
  });

  // Find templates using regular expression
  const regex = /(?<!\{)\{\{(?!\{)([^\|\}\n]+)([\s\S]*?)\}\}/gi;

  return prompt.replace(regex, (match, templateName, rest) => {
      const lowerName = templateName.trim().toLowerCase();
      if (templateMap[lowerName]) {
          return `{{${templateMap[lowerName]}${rest}}}`;
      }
      return match; // Return as it is if not a replacement target
  });
}

const replaceStrForTranslation = function(txt) {
	const matchHangul = [
		/* ㅏ,ㅓ,ㅕ,ㅗ,ㅛ,ㅜ,ㅡ,ㅣ,ㅐ,ㅚ,ㅟ */
		// ㅏ 
		{
			key: '[각-갛]',
			val: '간'
		},
		{
			key: '[낙-낳]',
			val: '난'
		},
		{
			key: '[닥-닿]',
			val: '단'
		},
		{
			key: '[락-랗]',
			val: '란'
		},
		{
			key: '[막-맣]',
			val: '만'
		},
		{
			key: '[박-밯]',
			val: '반'
		},
		{
			key: '[삭-샇]',
			val: '산'
		},
		{
			key: '[악-앟]',
			val: '안'
		},
		{
			key: '[작-잫]',
			val: '잔'
		},
		{
			key: '[착-챃]',
			val: '찬'
		},
		{
			key: '[칵-캏]',
			val: '칸'
		},
		{
			key: '[탁-탛]',
			val: '탄'
		},
		{
			key: '[팍-팧]',
			val: '판'
		},
		{
			key: '[학-핳]',
			val: '한'
		},
		{
			key: '[깍-깧]',
			val: '깐'
		},
		{
			key: '[딱-땋]',
			val: '딴'
		},
		{
			key: '[빡-빻]',
			val: '빤'
		},
		{
			key: '[싹-쌓]',
			val: '싼'
		},
		{
			key: '[짝-짷]',
			val: '짠'
		},

		// ㅓ 
		{
			key: '[건-겋]',
			val: '건'
		},
		{
			key: '[넉-넣]',
			val: '넌'
		},
		{
			key: '[덕-덯]',
			val: '던'
		},
		{
			key: '[럭-렇]',
			val: '런'
		},
		{
			key: '[먹-멓]',
			val: '먼'
		},
		{
			key: '[벅-벟]',
			val: '번'
		},
		{
			key: '[석-섷]',
			val: '선'
		},
		{
			key: '[억-엏]',
			val: '언'
		},
		{
			key: '[적-젛]',
			val: '전'
		},
		{
			key: '[척-첳]',
			val: '천'
		},
		{
			key: '[컥-컿]',
			val: '컨'
		},
		{
			key: '[턱-텋]',
			val: '턴'
		},
		{
			key: '[퍽-펗]',
			val: '펀'
		},
		{
			key: '[헉-헣]',
			val: '헌'
		},
		{
			key: '[꺽-껗]',
			val: '껀'
		},
		{
			key: '[떡-떻]',
			val: '떤'
		},
		{
			key: '[뻑-뻫]',
			val: '뻔'
		},
		{
			key: '[썩-쎃]',
			val: '썬'
		},
		{
			key: '[쩍-쩧]',
			val: '쩐'
		},

		// ㅕ
		{
			key: '[견-곃]',
			val: '견'
		},
		{
			key: '[녁-녛]',
			val: '년'
		},
		{
			key: '[뎍-뎧]',
			val: '뎐'
		},
		{
			key: '[력-렿]',
			val: '련'
		},
		{
			key: '[멱-몋]',
			val: '면'
		},
		{
			key: '[벽-볗]',
			val: '변'
		},
		{
			key: '[셕-셯]',
			val: '션'
		},
		{
			key: '[역-옇]',
			val: '연'
		},
		{
			key: '[젹-졓]',
			val: '젼'
		},
		{
			key: '[쳑-쳫]',
			val: '쳔'
		},
		{
			key: '[켝-켷]',
			val: '켠'
		},
		{
			key: '[텩-톃]',
			val: '텬'
		},
		{
			key: '[펵-폏]',
			val: '편'
		},
		{
			key: '[혁-혛]',
			val: '현'
		},
		{
			key: '[껵-꼏]',
			val: '껸'
		},
		{
			key: '[뗙-뗳]',
			val: '뗜'
		},
		{
			key: '[뼉-뼣]',
			val: '뼌'
		},
		{
			key: '[쎡-쎻]',
			val: '쎤'
		},
		{
			key: '[쪅-쪟]',
			val: '쪈'
		},

		// ㅗ
		{
			key: '[곡-곻]',
			val: '곤'
		},
		{
			key: '[녹-놓]',
			val: '논'
		},
		{
			key: '[독-돟]',
			val: '돈'
		},
		{
			key: '[록-롷]',
			val: '론'
		},
		{
			key: '[목-뫃]',
			val: '몬'
		},
		{
			key: '[복-봏]',
			val: '본'
		},
		{
			key: '[속-솧]',
			val: '손'
		},
		{
			key: '[옥-옿]',
			val: '온'
		},
		{
			key: '[족-좋]',
			val: '존'
		},
		{
			key: '[촉-촣]',
			val: '촌'
		},
		{
			key: '[콕-콯]',
			val: '콘'
		},
		{
			key: '[톡-톻]',
			val: '톤'
		},
		{
			key: '[폭-퐇]',
			val: '폰'
		},
		{
			key: '[혹-홓]',
			val: '혼'
		},
		{
			key: '[꼭-꽇]',
			val: '꼰'
		},
		{
			key: '[똑-똫]',
			val: '똔'
		},
		{
			key: '[뽁-뽛]',
			val: '뽄'
		},
		{
			key: '[쏙-쏳]',
			val: '쏜'
		},
		{
			key: '[쪽-쫗]',
			val: '쫀'
		},

		// ㅛ
		{
			key: '[굑-굫]',
			val: '굔'
		},
		{
			key: '[뇩-눃]',
			val: '뇬'
		},
		{
			key: '[됵-둏]',
			val: '됸'
		},
		{
			key: '[룍-룧]',
			val: '룐'
		},
		{
			key: '[묙-묳]',
			val: '묜'
		},
		{
			key: '[뵥-뵿]',
			val: '뵨'
		},
		{
			key: '[쇽-숗]',
			val: '숀'
		},
		{
			key: '[욕-욯]',
			val: '욘'
		},
		{
			key: '[죡-죻]',
			val: '죤'
		},
		{
			key: '[쵹-춓]',
			val: '쵼'
		},
		{
			key: '[쿅-쿟]',
			val: '쿈'
		},
		{
			key: '[툑-툫]',
			val: '툔'
		},
		{
			key: '[푝-푷]',
			val: '푠'
		},
		{
			key: '[횩-훃]',
			val: '횬'
		},
		{
			key: '[꾝-꾷]',
			val: '꾠'
		},
		{
			key: '[뚁-뚛]',
			val: '뚄'
		},
		{
			key: '[뾱-뿋]',
			val: '뾴'
		},
		{
			key: '[쑉-쑣]',
			val: '쑌'
		},
		{
			key: '[쬭-쭇]',
			val: '쬰'
		},

		// ㅜ
		{
			key: '[국-궇]',
			val: '군'
		},
		{
			key: '[눅-눟]',
			val: '눈'
		},
		{
			key: '[둑-둫]',
			val: '둔'
		},
		{
			key: '[룩-뤃]',
			val: '룬'
		},
		{
			key: '[묵-뭏]',
			val: '문'
		},
		{
			key: '[북-붛]',
			val: '분'
		},
		{
			key: '[숙-숳]',
			val: '순'
		},
		{
			key: '[욱-웋]',
			val: '운'
		},
		{
			key: '[죽-줗]',
			val: '준'
		},
		{
			key: '[축-춯]',
			val: '춘'
		},
		{
			key: '[쿡-쿻]',
			val: '쿤'
		},
		{
			key: '[툭-퉇]',
			val: '툰'
		},
		{
			key: '[푹-풓]',
			val: '푼'
		},
		{
			key: '[훅-훟]',
			val: '훈'
		},
		{
			key: '[꾹-꿓]',
			val: '꾼'
		},
		{
			key: '[뚝-뚷]',
			val: '뚠'
		},
		{
			key: '[뿍-뿧]',
			val: '뿐'
		},
		{
			key: '[쑥-쑿]',
			val: '쑨'
		},
		{
			key: '[쭉-쭣]',
			val: '쭌'
		},

		// ㅡ
		{
			key: '[극-긓]',
			val: '근'
		},
		{
			key: '[늑-늫]',
			val: '는'
		},
		{
			key: '[득-듷]',
			val: '든'
		},
		{
			key: '[륵-릏]',
			val: '른'
		},
		{
			key: '[믁-믛]',
			val: '믄'
		},
		{
			key: '[븍-븧]',
			val: '븐'
		},
		{
			key: '[슥-슿]',
			val: '슨'
		},
		{
			key: '[윽-읗]',
			val: '은'
		},
		{
			key: '[즉-즣]',
			val: '즌'
		},
		{
			key: '[측-츻]',
			val: '츤'
		},
		{
			key: '[큭-킇]',
			val: '큰'
		},
		{
			key: '[특-틓]',
			val: '튼'
		},
		{
			key: '[픅-픟]',
			val: '픈'
		},
		{
			key: '[흑-흫]',
			val: '흔'
		},
		{
			key: '[끅-끟]',
			val: '끈'
		},
		{
			key: '[뜩-띃]',
			val: '뜬'
		},
		{
			key: '[쁙-쁳]',
			val: '쁜'
		},
		{
			key: '[쓱-씋]',
			val: '쓴'
		},
		{
			key: '[쯕-쯯]',
			val: '쯘'
		},

		// ㅣ
		{
			key: '[긱-깋]',
			val: '긴'
		},
		{
			key: '[닉-닣]',
			val: '닌'
		},
		{
			key: '[딕-딯]',
			val: '딘'
		},
		{
			key: '[릭-맇]',
			val: '린'
		},
		{
			key: '[믹-밓]',
			val: '민'
		},
		{
			key: '[빅-빟]',
			val: '빈'
		},
		{
			key: '[식-싷]',
			val: '신'
		},
		{
			key: '[익-잏]',
			val: '인'
		},
		{
			key: '[직-짛]',
			val: '진'
		},
		{
			key: '[칙-칳]',
			val: '친'
		},
		{
			key: '[킥-킿]',
			val: '킨'
		},
		{
			key: '[틱-팋]',
			val: '틴'
		},
		{
			key: '[픽-핗]',
			val: '핀'
		},
		{
			key: '[힉-힣]',
			val: '힌'
		},
		{
			key: '[끽-낗]',
			val: '낀'
		},
		{
			key: '[띡-띻]',
			val: '띤'
		},
		{
			key: '[삑-삫]',
			val: '삔'
		},
		{
			key: '[씩-앃]',
			val: '씬'
		},
		{
			key: '[찍-찧]',
			val: '찐'
		},

		// ㅐ
		{
			key: '[객-갷]',
			val: '갠'
		},
		{
			key: '[낵-냏]',
			val: '낸'
		},
		{
			key: '[댁-댛]',
			val: '댄'
		},
		{
			key: '[랙-랳]',
			val: '랜'
		},
		{
			key: '[맥-맿]',
			val: '맨'
		},
		{
			key: '[백-뱋]',
			val: '밴'
		},
		{
			key: '[색-샣]',
			val: '샌'
		},
		{
			key: '[액-앻]',
			val: '앤'
		},
		{
			key: '[잭-쟇]',
			val: '잰'
		},
		{
			key: '[책-챟]',
			val: '챈'
		},
		{
			key: '[캑-캫]',
			val: '캔'
		},
		{
			key: '[택-탷]',
			val: '탠'
		},
		{
			key: '[팩-퍃]',
			val: '팬'
		},
		{
			key: '[핵-햏]',
			val: '핸'
		},
		{
			key: '[깩-꺃]',
			val: '깬'
		},
		{
			key: '[땍-땧]',
			val: '땐'
		},
		{
			key: '[빽-뺗]',
			val: '뺀'
		},
		{
			key: '[쌕-쌯]',
			val: '쌘'
		},
		{
			key: '[짹-쨓]',
			val: '짼'
		},

		// ㅚ
		{
			key: '[괵-굏]',
			val: '괸'
		},
		{
			key: '[뇍-뇧]',
			val: '뇐'
		},
		{
			key: '[됙-됳]',
			val: '된'
		},
		{
			key: '[뢱-룋]',
			val: '뢴'
		},
		{
			key: '[뫽-묗]',
			val: '묀'
		},
		{
			key: '[뵉-뵣]',
			val: '뵌'
		},
		{
			key: '[쇡-쇻]',
			val: '쇤'
		},
		{
			key: '[왹-욓]',
			val: '왼'
		},
		{
			key: '[죅-죟]',
			val: '죈'
		},
		{
			key: '[쵝-쵷]',
			val: '쵠'
		},
		{
			key: '[쾩-쿃]',
			val: '쾬'
		},
		{
			key: '[퇵-툏]',
			val: '퇸'
		},
		{
			key: '[푁-푛]',
			val: '푄'
		},
		{
			key: '[획-횧]',
			val: '횐'
		},
		{
			key: '[꾁-꾛]',
			val: '꾄'
		},
		{
			key: '[뙥-뙿]',
			val: '뙨'
		},
		{
			key: '[뾕-뾯]',
			val: '뾘'
		},
		{
			key: '[쐭-쑇]',
			val: '쐰'
		},
		{
			key: '[쬑-쬫]',
			val: '쬔'
		},

		// ㅟ
		{
			key: '[귁-귛]',
			val: '귄'
		},
		{
			key: '[뉙-뉳]',
			val: '뉜'
		},
		{
			key: '[뒥-뒿]',
			val: '뒨'
		},
		{
			key: '[뤽-륗]',
			val: '륀'
		},
		{
			key: '[뮉-뮣]',
			val: '뮌'
		},
		{
			key: '[뷕-뷯]',
			val: '뷘'
		},
		{
			key: '[쉭-슇]',
			val: '쉰'
		},
		{
			key: '[윅-윟]',
			val: '윈'
		},
		{
			key: '[쥑-쥫]',
			val: '쥔'
		},
		{
			key: '[췩-츃]',
			val: '췬'
		},
		{
			key: '[퀵-큏]',
			val: '퀸'
		},
		{
			key: '[튁-튛]',
			val: '튄'
		},
		{
			key: '[퓍-퓧]',
			val: '퓐'
		},
		{
			key: '[휙-휳]',
			val: '휜'
		},
		{
			key: '[뀍-뀧]',
			val: '뀐'
		},
		{
			key: '[뛱-뜋]',
			val: '뛴'
		},
		{
			key: '[쀡-쀻]',
			val: '쀤'
		},
		{
			key: '[쒹-쓓]',
			val: '쒼'
		},
		{
			key: '[쮝-쮷]',
			val: '쮠'
		},
	];
		var result = "";
		txt = txt
			.replace(/ 그렇습니다(\.|<|\()/g, ' 그렇다$1')
			.replace(/좁습니다(\.|<|\()/g, '좁다$1')
			.replace(/넓습니다(\.|<|\()/g, '넓다$1')
			.replace(/졌습니다(\.|<|\()/g, '졌다$1')
			.replace(/([있없갔었였했았렸렀짧꼈겠켰됐났쳤겼같높낮녔많깝왔썼잤랐렵냈뒀혔롭럽좋싫췄섰웠맵])습니다(\.|<|\()/g, '$1다$2')
			.replace(/ (우세|유능|무능|무능력|촉촉|익숙|순|편안|편리|간편|중요|확실|불확실|필요|불편|편|동일|암울|우울|귀중|소중|모호|애매|애매모호|유명|저명|다양|잔인|강인|상이|편협|협소|광대|광활|불과|간결|가능|불가|불가능|흔|가득|독특|특별|적합|부적합|적절|부적절|유사|유연|뻣뻣|행복|비슷|분명|곤란|불안)합니다(\.|<|\()/g, ' $1하다$2')
			//.replace(/이기도 합니다(\.|<|\()/g,'이기도 하다$1') // TO-DO: Fix 학생이기도 합니다(학생이기도 하다) and 쓰이기도 합니다(쓰이기도 한다)
			.replace(/ 아닙니다(\.|<|\()/g, ' 아니다$1')
			.replace(/ 보입니다(\.|<|\()/g, ' 보인다$1')
			.replace(/ 줄입니다(\.|<|\()/g, ' 줄인다$1')
			.replace(/ 높입니다(\.|<|\()/g, ' 높인다$1')
			.replace(/ 작습니다(\.|<|\()/g, ' 작다$1')
			.replace(/ 바람직합니다(\.|<|\()/g, ' 바람직하다$1')
			.replace(/ 저렴합니다(\.|<|\()/g, ' 저렴하다$1')
			//.replace(/ 절입니다(\.|<|\()/g,' 절인다$1') // TO-DO: Fix noun(절) and verb(절)
			.replace(/들입니다(\.|<|\()/g, '들인다$1') // e.g, 들인다, 곁들인다
			.replace(/입니다(\.|<|\()/g, '이다$1')
			.replace(/쁩니다(\.|<|\()/g, '쁘다$1') // e.g, 기쁩니다, 예쁩니다
			.replace(/쉽니다(\.|<|\()/g, '쉰다$1') // e.g, 내쉽니다
			.replace(/쉽습니다(\.|<|\()/g, '쉽다$1') // e.g, 쉽습니다, 아쉽습니다
			.replace(/ 부릅니다(\.|<|\()/g, ' 부른다$1')
			.replace(/ 바릅니다(\.|<|\()/g, ' 바른다$1')
			.replace(/릅니다(\.|<|\()/g, '르다$1') // e.g, 푸르릅니다, 다릅니다
			.replace(/ 깁니다(\.|<|\()/g, ' 길다$1'); // but note: 굶깁니다 → 굶긴다

		for (var i = 0; i < txt.split(/\n/).length; i++) {
			var line = txt.split(/\n/)[i];
			if (!/니다(\.|<|\()/.test(line)) {
				result += line + "\n";
				continue;
			}
			// e.g, 엮습니다 → 엮는다
			if (/습니다(\.|<|\()/.test(line)) {
				line = line.replace(/습니다(\.|<|\()/g, '는다$1');
			}
			if (/[가-힣]니다(\.|<|\()/.test(line)) {
				for (var i2 = 0; i2 < matchHangul.length; i2++) {
					var key = matchHangul[i2].key;
					var val = matchHangul[i2].val;
					line = line.replace(new RegExp(key + "니다(\\.|<|\\()", "g"), val + "다$1");
				}
			}
			result += line + "\n";
		}
		return result.trim() + "\n";
	};

module.exports = {
  cleanupTemplates,
  removeTemplates,
  removeCategories,
  removeItalicsPreserveBold,
  replaceTemplates,
  replaceStrForTranslation
}; 