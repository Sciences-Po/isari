import { TranslateService, LangChangeEvent } from 'ng2-translate';
import { IsariDataService } from './../isari-data.service';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/operator/combineLatest';
import 'rxjs/add/operator/switchMap';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { Component, OnInit } from '@angular/core';

import keyBy from 'lodash/keyBy';
import flattenDeep from 'lodash/flattenDeep';
import uniq from 'lodash/uniq';
import { BehaviorSubject } from 'rxjs';
import { EditLogApiOptions } from './EditLogApiOptions.class';
import { ToasterService } from "angular2-toaster";

@Component({
  selector: 'isari-logs',
  templateUrl: './isari-logs.component.html',
  // styleUrls: ['./isari-layout.component.css']
})
export class IsariLogsComponent implements OnInit {

  feature: string;
  options: EditLogApiOptions = { skip: 0, limit: 5 };
  options$: BehaviorSubject<EditLogApiOptions>;
  details$: BehaviorSubject<boolean>;
  logs$: Observable<any[]>;
  labs$: Observable<any[]>;

  constructor(
    private route: ActivatedRoute,
    private isariDataService: IsariDataService,
    private translate: TranslateService,
    private router: Router,
    private toasterService: ToasterService
  ) { }

  ngOnInit() {
    this.options$ = new BehaviorSubject(this.options);
    this.details$ = new BehaviorSubject(false);
    this.logs$ = Observable
    .combineLatest([
      this.route.paramMap,
      this.options$,
      this.translate.onLangChange
        .map((event: LangChangeEvent) => event.lang)
        .startWith(this.translate.currentLang)
    ])
    .switchMap(([paramMap, options, lang]) => {
      this.feature = (<ParamMap>paramMap).get('feature');
      this.options = Object.assign({}, {
        itemID: (<ParamMap>paramMap).get('itemID')
      }, options);

      return this.isariDataService
      .getHistory(this.feature, this.options, lang)
      .catch(err => {
        if (err.status === 401) {
          this.toasterService.pop('error', '', 'Unauthoried feature');
          this.router.navigate(['/', this.feature], { preserveQueryParams: true });
        }
        return Observable.throw(err);
      })
      .combineLatest(this.details$)
    })
    .map(([{count, logs}, details]) => {
      this.labs$ = this.isariDataService.getForeignLabel('Organization', uniq(flattenDeep(logs.map(log => log.who.roles.map(role => role.lab)))))
        .map(labs => keyBy(labs, 'id'));

        if (details && this.options['path']) return logs.map(log => Object.assign({}, log, {
        _open: true,
        diff: log.diff.filter(diff => diff.path[0] === this.options['path'])
      }));

      return {
        count,
        logs: logs.map(log => Object.assign({}, log, { _open: details }))
      };
    });
  }

  changeOpt(options) {
    this.options = options;
    this.options$.next(options);
  }

  toggleDetails() {
    this.details$.next(!this.details$.value);
  }

  exportLogs({logs, filetype}) {
    this.isariDataService.exportLogs(logs, this.feature, this.labs$, this.translate, this.details$.value, filetype);
  }

}
